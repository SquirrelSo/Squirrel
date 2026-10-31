"""High Knee timed-set adapter over ROM, two lift detectors, metrics, cues and scoring.

The adapter is complete enough for backend construction and the later backend-only rig, but it is
intentionally not registered in the production builder map while High Knee remains catalog-planned.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, is_dataclass
from pathlib import Path

from backend.core.frame import TrainingFrame
from backend.engine.cues import CueCandidate, CueSelector
from backend.engine.loader import ExerciseConfiguration, validate_exercise_config
from backend.training.timed_contract import (
    LiftCycleEvent,
    TimedMovementCounters,
)
from backend.training.timed_set import TimedSetTimer
from backend.workouts.high_knee.lift_detector import (
    DetectedLiftCycle,
    HighKneeLiftState,
    high_knee_lift_detector,
)
from backend.workouts.high_knee.rules.registry import active_live_rule_modules
from backend.workouts.high_knee.set_scorer import (
    HighKneeLiftScorer,
    HighKneeSetScorer,
)

_PACKAGE_DIR = Path(__file__).resolve().parent
_SIDES = ("left", "right")


class HighKneeAdapterConfigurationError(ValueError):
    """The selected baseline or High Knee runtime policy cannot build a safe adapter."""


class HighKneeAdapter:
    """Coordinate one continuous timed High Knee interval."""

    def __init__(
        self,
        *,
        baseline: dict,
        target_duration_ms: int,
        config: ExerciseConfiguration,
    ) -> None:
        if not isinstance(baseline, dict):
            raise HighKneeAdapterConfigurationError("baseline must be a mapping")
        if (
            not isinstance(target_duration_ms, int)
            or isinstance(target_duration_ms, bool)
            or target_duration_ms < 1
        ):
            raise HighKneeAdapterConfigurationError(
                "target_duration_ms must be a positive integer"
            )
        if config.fsm.get("movement_type") != "time":
            raise HighKneeAdapterConfigurationError(
                "High Knee requires a timed exercise configuration"
            )

        self._config = config
        modules = active_live_rule_modules(config)
        self._rules = {
            rule_id: _build_rule(rule_id, module, config.templates[rule_id], baseline)
            for rule_id, module in modules.items()
        }
        self._live_rule_ids = tuple(
            sorted(self._rules, key=lambda rule_id: config.templates[rule_id]["rank"])
        )
        try:
            self._rom = self._rules["knee_drive_rom"]
        except KeyError as exc:
            raise HighKneeAdapterConfigurationError(
                "High Knee requires an active knee_drive_rom rule"
            ) from exc
        # The monitor may be absent in older captured configurations. Current live configuration
        # enables it, while replay remains backward-compatible with those earlier rig sessions.
        self._asymmetry = self._rules.get("left_right_asymmetry")

        detector_inputs = {
            "reached_gate": self._rom.is_full_rom,
            "fsm": config.fsm,
            "max_frame_delta_ms": config.scoring["max_frame_delta_ms"],
            "frame_cadence": config.scoring.get("frame_cadence"),
        }
        self._detectors = {
            side: high_knee_lift_detector(side, **detector_inputs)
            for side in _SIDES
        }
        self._timer = TimedSetTimer(target_duration_ms)
        self._scorer = HighKneeSetScorer(config)
        self._lift_scorer = HighKneeLiftScorer(config)
        self._cue_selector = CueSelector(
            min_display_ms=float(config.scoring["cue_min_display_ms"])
        )

        self._next_lift_id = 1
        self._detected_cycles = 0
        self._counted_lifts = 0
        self._full_lifts = 0
        self._shallow_lifts = 0
        self._invalid_lifts = 0
        self._side_lifts = {"left": 0, "right": 0}
        self._alternation_breaks = 0
        self._last_counted_side: str | None = None
        self._last_cadence_t_ms: float | None = None
        self._current_cadence_spm: float | None = None
        self._peak_cadence_spm: float | None = None

        self._last_rule_results: dict[str, dict] = {}
        self._last_fsm_diagnostics: dict[str, dict] = {}
        self._issue_started_t_ms: dict[tuple[str, str | None], float] = {}
        self._last_lift_score = None
        self._last_status: dict | None = None
        self._complete = False

    @property
    def active_rule_ids(self) -> tuple[str, ...]:
        return self._live_rule_ids

    def process(self, frame: TrainingFrame) -> dict:
        if not isinstance(frame, TrainingFrame):
            raise TypeError("frame must be a TrainingFrame")
        if self._complete:
            return self._post_completion_status()

        timer = self._timer.update(frame.t_ms)
        readings = {
            rule_id: rule.read(frame.keypoints)
            for rule_id, rule in self._rules.items()
            if rule_id != "left_right_asymmetry"
        }
        rom = readings["knee_drive_rom"]
        states: dict[str, HighKneeLiftState] = {}
        detections: list[DetectedLiftCycle] = []
        for side in _SIDES:  # stable simultaneous completion order: left, then right
            available = getattr(rom, f"{side}_available")
            progress = getattr(rom, f"{side}_progress_raw") if available else None
            state = self._detectors[side].update(progress, frame.t_ms)
            states[side] = state
            if state.cycle is not None:
                detections.append(state.cycle)

        events = self._record_detections(detections)
        if self._asymmetry is not None:
            for event in events:
                self._asymmetry.record(event)
            readings["left_right_asymmetry"] = self._asymmetry.read()
        self._update_cadence(events)
        tracking_available = rom.left_available or rom.right_available
        rule_states = self._rule_states(readings, states)
        self._scorer.push_frame(
            t_ms=frame.t_ms,
            phase=_timeline_phase(states),
            rule_states=rule_states,
            tracking=tracking_available,
        )
        events_by_side = {event.side: event for event in events}
        tracking_invalid_by_side = {
            detection.side: detection.tracking_invalid for detection in detections
        }
        for side in _SIDES:
            event = events_by_side.get(side)
            lift_score = self._lift_scorer.push_frame(
                side=side,
                t_ms=frame.t_ms,
                phase=states[side].internal_phase,
                rule_states=self._side_rule_states(readings, states[side]),
                tracking=states[side].tracking,
                event=event,
                tracking_invalid=tracking_invalid_by_side.get(side, False),
            )
            if lift_score is not None and event is not None and event.counted:
                # High Knees normally completes one side at a time. If both sides finish on the
                # same frame, the established stable left-then-right ordering makes right the
                # latest completed lift shown by the single HUD score.
                self._last_lift_score = lift_score
        score = self._scorer.score()

        issues = self._confirmed_issues(
            self._issues(readings, states),
            frame.t_ms,
        )
        candidates = [
            CueCandidate(
                issue["id"],
                issue["cue"],
                issue["rank"],
                coaching=issue["coaching"],
            )
            for issue in issues
        ]
        if any(detection.reason == "too_slow" for detection in detections):
            # A march, not a run: said at once, while the person can speed up.
            candidates.append(
                CueCandidate("tempo", self._config.fsm["too_slow_cue"], 1, display_ms=2500.0)
            )
        if any(event.classification == "shallow" for event in events):
            template = self._config.templates["knee_drive_rom"]
            candidates.append(
                CueCandidate(
                    "knee_drive_rom",
                    template["cue"],
                    template["rank"],
                    coaching=template["coaching"],
                )
            )
        cue = self._cue_selector.select(candidates, frame.t_ms)
        # CueSelector retains a selected cue for its display dwell. Once a movement fault is no
        # longer confirmed, do not publish that retained penalty cue without its red/side issue
        # metadata; otherwise the UI has to guess and used to fall back to both legs in amber.
        if (
            cue is not None
            and cue.rule_id in self._scorer.penalty_rule_ids
            and not any(issue["id"] == cue.rule_id for issue in issues)
        ):
            cue = None
        status = self._status(
            timer.status.document(),
            timer.set_completed,
            rom,
            states,
            events,
            score,
            self._last_lift_score,
            cue,
            issues,
            rule_states,
            readings.get("left_right_asymmetry"),
        )
        self._last_rule_results = self._debug_rule_results(readings, states)
        self._last_fsm_diagnostics = {
            side: deepcopy(state.diagnostics) for side, state in states.items()
        }
        self._last_status = deepcopy(status)
        self._complete = timer.status.complete
        return status

    def debug_snapshot(self) -> dict:
        return {
            "rules": deepcopy(self._last_rule_results),
            "fsm": deepcopy(self._last_fsm_diagnostics),
        }

    def runtime_metadata(self) -> dict:
        return {
            "active_rule_ids": list(self.active_rule_ids),
            "templates": deepcopy(self._config.templates),
            "contexts": deepcopy(self._config.contexts),
            "scoring": deepcopy(self._config.scoring),
            "fsm": deepcopy(self._config.fsm),
            "signal_reference": {
                "rule_id": "knee_drive_rom",
                "left_baseline_gap_px": round(
                    self._rom.baseline_gap_px("left"), 6
                ),
                "right_baseline_gap_px": round(
                    self._rom.baseline_gap_px("right"), 6
                ),
            },
        }

    def _record_detections(
        self,
        detections: list[DetectedLiftCycle],
    ) -> list[LiftCycleEvent]:
        events: list[LiftCycleEvent] = []
        for detection in detections:
            event = LiftCycleEvent(
                self._next_lift_id,
                detection.side,
                detection.classification,
                detection.peak_progress,
                detection.started_t_ms,
                detection.completed_t_ms,
            )
            self._next_lift_id += 1
            self._detected_cycles += 1
            if event.classification == "invalid":
                self._invalid_lifts += 1
            else:
                self._counted_lifts += 1
                self._side_lifts[event.side] += 1
                if event.classification == "full_rom":
                    self._full_lifts += 1
                else:
                    self._shallow_lifts += 1
                if self._last_counted_side == event.side:
                    self._alternation_breaks += 1
                self._last_counted_side = event.side
            self._scorer.record_cycle(
                event,
                tracking_invalid=detection.tracking_invalid,
            )
            events.append(event)
        return events

    def _update_cadence(self, events: list[LiftCycleEvent]) -> None:
        counted = [event for event in events if event.counted]
        if not counted:
            return
        timestamp = max(event.completed_t_ms for event in counted)
        if self._last_cadence_t_ms is not None and timestamp > self._last_cadence_t_ms:
            cadence = len(counted) * 60_000.0 / (timestamp - self._last_cadence_t_ms)
            self._current_cadence_spm = round(cadence, 1)
            self._peak_cadence_spm = round(
                max(self._peak_cadence_spm or 0.0, cadence), 1
            )
        self._last_cadence_t_ms = timestamp

    def _movement_document(
        self,
        elapsed_ms: float,
        states: dict[str, HighKneeLiftState],
    ) -> dict:
        counters = TimedMovementCounters(
            self._detected_cycles,
            self._counted_lifts,
            self._full_lifts,
            self._shallow_lifts,
            self._invalid_lifts,
            self._side_lifts["left"],
            self._side_lifts["right"],
        )
        document = asdict(counters)
        document.update(
            current_cadence_spm=self._current_cadence_spm,
            average_cadence_spm=(
                round(self._counted_lifts * 60_000.0 / elapsed_ms, 1)
                if elapsed_ms > 0 and self._counted_lifts
                else None
            ),
            peak_cadence_spm=self._peak_cadence_spm,
            alternation_breaks=self._alternation_breaks,
            last_counted_side=self._last_counted_side,
            left_phase=states["left"].phase,
            right_phase=states["right"].phase,
            left_current_peak=states["left"].current_peak,
            right_current_peak=states["right"].current_peak,
        )
        return document

    def _rule_states(
        self,
        readings: dict[str, object | None],
        states: dict[str, HighKneeLiftState],
    ) -> dict[str, bool | None]:
        """Reduce per-knee readings without treating an unobserved active knee as safe."""
        result: dict[str, bool | None] = {}
        for rule_id in self._scorer.penalty_rule_ids:
            template = self._config.templates[rule_id]
            active_sides = _active_sides(states, template["active_phases"])
            if not active_sides:
                result[rule_id] = False
                continue
            reading = readings[rule_id]
            if reading is None:
                result[rule_id] = None
                continue
            if rule_id != "knee_tracking_corridor":
                result[rule_id] = bool(getattr(reading, "not_ok"))
                continue
            observed_fault = False
            unavailable = False
            for side in active_sides:
                available = bool(getattr(reading, f"{side}_available"))
                if not available:
                    unavailable = True
                    continue
                observed_fault = observed_fault or bool(
                    getattr(reading, f"{side}_not_ok")
                )
            result[rule_id] = True if observed_fault else None if unavailable else False
        return result

    def _side_rule_states(
        self,
        readings: dict[str, object | None],
        state: HighKneeLiftState,
    ) -> dict[str, bool | None]:
        """Return fault evidence for exactly one lift, independent of the other leg."""
        result: dict[str, bool | None] = {}
        for rule_id in self._scorer.penalty_rule_ids:
            template = self._config.templates[rule_id]
            if state.internal_phase not in template["active_phases"]:
                result[rule_id] = False
                continue
            reading = readings[rule_id]
            if reading is None:
                result[rule_id] = None
                continue
            if rule_id != "knee_tracking_corridor":
                result[rule_id] = bool(getattr(reading, "not_ok"))
                continue
            if not bool(getattr(reading, f"{state.side}_available")):
                result[rule_id] = None
                continue
            result[rule_id] = bool(getattr(reading, f"{state.side}_not_ok"))
        return result

    def _issues(
        self,
        readings: dict[str, object | None],
        states: dict[str, HighKneeLiftState],
    ) -> list[dict]:
        issues: list[dict] = []
        for rule_id in self._scorer.penalty_rule_ids:
            template = self._config.templates[rule_id]
            active_sides = _active_sides(states, template["active_phases"])
            reading = readings[rule_id]
            if not active_sides or reading is None:
                continue
            if rule_id != "knee_tracking_corridor":
                if not bool(getattr(reading, "not_ok")):
                    continue
                issues.append(
                    {
                        "id": rule_id,
                        "label": template["fault_label"],
                        "tier": template["tier"],
                        "rank": template["rank"],
                        "side": getattr(reading, "side", None),
                        "state": getattr(reading, "state", None),
                        "skeleton_color": getattr(
                            reading, "skeleton_color", None
                        ),
                        "cue": template["cue"],
                        "coaching": template.get("coaching"),
                    }
                )
                continue
            fault_sides = [
                side
                for side in active_sides
                if bool(getattr(reading, f"{side}_available"))
                and bool(getattr(reading, f"{side}_not_ok"))
            ]
            if not fault_sides:
                continue
            side = "both" if len(fault_sides) == 2 else fault_sides[0]
            issues.append(
                {
                    "id": rule_id,
                    "label": template["fault_label"],
                    "tier": template["tier"],
                    "rank": template["rank"],
                    "side": side,
                    "state": "not_ok",
                    "skeleton_color": "red",
                    "cue": template["cue"],
                    "coaching": template.get("coaching"),
                }
            )
        return sorted(issues, key=lambda issue: (issue["rank"], issue["id"]))

    def _confirmed_issues(self, raw_issues: list[dict], t_ms: float) -> list[dict]:
        """Require continuous configured fault duration before publishing live feedback."""
        active: dict[tuple[str, str | None], float] = {}
        confirmed: list[dict] = []
        for issue in raw_issues:
            key = (issue["id"], issue.get("side"))
            started = self._issue_started_t_ms.get(key, t_ms)
            active[key] = started
            policy = self._config.templates[issue["id"]]["scoring"].get(
                "confirmed_fault"
            )
            required_ms = (
                0.0 if policy is None else float(policy["min_not_ok_ms"])
            )
            if t_ms - started >= required_ms:
                confirmed.append(issue)
        # Any safe/unavailable frame breaks continuity; a later fault starts a new window.
        self._issue_started_t_ms = active
        return confirmed

    def _status(
        self,
        set_status: dict,
        set_completed: bool,
        rom,
        states: dict[str, HighKneeLiftState],
        events: list[LiftCycleEvent],
        score,
        last_lift_score,
        cue: CueCandidate | None,
        issues: list[dict],
        rule_states: dict[str, bool | None],
        asymmetry,
    ) -> dict:
        unavailable = []
        if not (rom.left_available or rom.right_available):
            unavailable.append("knee_drive_rom")
        unavailable.extend(
            rule_id for rule_id, value in rule_states.items() if value is None
        )
        return {
            "tracking": {
                "available": rom.left_available or rom.right_available,
                "left_available": rom.left_available,
                "right_available": rom.right_available,
                "unavailable_rule_ids": unavailable,
            },
            "phase": "complete" if set_status["complete"] else "active",
            "movement": self._movement_document(set_status["elapsed_ms"], states),
            "rom": {
                "rule_id": "knee_drive_rom",
                "full_rom_gate": self._rom.full_rom_gate,
                "left_available": rom.left_available,
                "right_available": rom.right_available,
                "left_progress_raw": rom.left_progress_raw,
                "right_progress_raw": rom.right_progress_raw,
                "left_progress_display": rom.left_progress_display,
                "right_progress_display": rom.right_progress_display,
                "left_percent": _percent(rom.left_progress_display),
                "right_percent": _percent(rom.right_progress_display),
                "left_full_rom": (
                    self._rom.is_full_rom(rom.left_progress_raw)
                    if rom.left_available
                    else None
                ),
                "right_full_rom": (
                    self._rom.is_full_rom(rom.right_progress_raw)
                    if rom.right_available
                    else None
                ),
                "left_current_peak": states["left"].current_peak,
                "right_current_peak": states["right"].current_peak,
                "coaching": self._config.templates["knee_drive_rom"]["coaching"],
            },
            "active_rule_ids": list(self.active_rule_ids),
            "issues": [
                {
                    key: value
                    for key, value in issue.items()
                    if key not in {"rank", "cue", "coaching"}
                }
                for issue in issues
            ],
            "cue": (
                None
                if cue is None
                else {
                    "rule_id": cue.rule_id,
                    "text": cue.text,
                    "coaching": cue.coaching or "",
                }
            ),
            "score": asdict(score),
            # The cumulative set score above is persisted and reported. This side-local score is
            # only the latest completed lift and is the correct source for the live HUD.
            "last_lift_score": (
                None if last_lift_score is None else asdict(last_lift_score)
            ),
            "score_coverage": self._scorer.coverage_document(),
            "monitors": (
                {}
                if asymmetry is None
                else {"left_right_asymmetry": _reading_dict(asymmetry)}
            ),
            "set": set_status,
            "events": {
                "lift_cycles": [asdict(event) for event in events],
                "set_completed": set_completed,
            },
        }

    def _debug_rule_results(
        self,
        readings: dict[str, object],
        states: dict[str, HighKneeLiftState],
    ) -> dict[str, dict]:
        results: dict[str, dict] = {}
        for rule_id, template in sorted(
            self._config.templates.items(), key=lambda item: (item[1]["rank"], item[0])
        ):
            active = self._config.contexts["live"][rule_id]
            reading = readings.get(rule_id) if active else None
            phase_active = active and any(
                state.internal_phase in template["active_phases"]
                for state in states.values()
            )
            results[rule_id] = {
                "active": active,
                "phase_active": phase_active,
                "evaluated": active,
                "available": active and reading is not None and (
                    getattr(reading, "left_available", True)
                    or getattr(reading, "right_available", True)
                ),
                "result": _reading_dict(reading),
            }
        return results

    def _post_completion_status(self) -> dict:
        if self._last_status is None:
            raise RuntimeError("completed High Knee adapter has no final status")
        status = deepcopy(self._last_status)
        status["events"] = {"lift_cycles": [], "set_completed": False}
        return status


def build_high_knee_adapter(
    *,
    baseline: dict,
    target_duration_ms: int,
    config: ExerciseConfiguration | None = None,
) -> HighKneeAdapter:
    """Build the planned backend adapter directly without enabling the production catalog."""
    selected = config or validate_exercise_config("high_knee", _PACKAGE_DIR)
    try:
        return HighKneeAdapter(
            baseline=baseline,
            target_duration_ms=target_duration_ms,
            config=selected,
        )
    except (KeyError, StopIteration, TypeError, ValueError, RuntimeError) as exc:
        if isinstance(exc, HighKneeAdapterConfigurationError):
            raise
        raise HighKneeAdapterConfigurationError(str(exc)) from exc


def _build_rule(rule_id: str, module, template: dict, baseline: dict):
    if rule_id == "knee_tracking_corridor":
        policy = template["policy"]
        return module.KneeTrackingCorridorRule(
            baseline,
            policy["mode"],
            policy["ranges"],
            min_shoulder_width_px=template["min_shoulder_width_px"],
            min_torso_length_px=template["min_torso_length_px"],
        )
    if rule_id == "lateral_torso_lean":
        policy = template["policy"]
        return module.LateralTorsoLeanRule(
            baseline,
            policy["mode"],
            policy["ranges"],
            min_torso_length_px=template["min_torso_length_px"],
        )
    if rule_id == "knee_drive_rom":
        return module.KneeDriveRomRule(
            baseline,
            template["full_rom_gate"],
            min_baseline_gap_px=template["min_baseline_gap_px"],
            min_torso_length_px=template["min_torso_length_px"],
        )
    if rule_id == "left_right_asymmetry":
        return module.LeftRightAsymmetryRule(
            min_lifts_per_side=template["min_lifts_per_side"],
            max_travel_gap=template["max_travel_gap"],
        )
    raise HighKneeAdapterConfigurationError(
        f"unsupported active High Knee rule: {rule_id}"
    )


def _active_sides(
    states: dict[str, HighKneeLiftState], active_phases: list[str]
) -> tuple[str, ...]:
    return tuple(
        side
        for side in _SIDES
        if states[side].internal_phase in active_phases
    )


def _timeline_phase(states: dict[str, HighKneeLiftState]) -> str:
    for side in _SIDES:
        phase = states[side].internal_phase
        if phase in {"ascent", "top", "descent"}:
            return phase
    return "setup"


def _percent(value: float | None) -> int | None:
    return None if value is None else round(value * 100)


def _reading_dict(reading: object | None) -> dict | None:
    if reading is None:
        return None
    if not is_dataclass(reading):
        raise TypeError("rule readings must be dataclass instances")
    return asdict(reading)
