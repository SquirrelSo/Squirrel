"""Push-up-specific live adapter: pose frames to phases, reps, scores, issues and cues.

Same shape and responsibilities as the squat adapter — the generic WebSocket transport knows none of
these push-up details. What differs is only what a push-up is:

    * the ROM template is `pushup_depth` (normalized elbow flexion against the captured plank),
    * the fault template is `body_line` (signed hip offset, so sag and pike coach apart),
    * `side_view_orientation` rides along as a live MONITOR, cueing a camera problem without ever
      touching a score, because a wrong camera angle is not a fault in the user's form.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, is_dataclass
from math import isfinite
from numbers import Real
from types import ModuleType

from backend.core.frame import TrainingFrame
from backend.engine.cues import CueCandidate, CueSelector
from backend.engine import rep_outcome
from backend.engine.loader import ExerciseConfiguration, load_exercise_config
from backend.engine.scorer import CompletedRep, RepScore, RepScorer, ScoreCoverage
from backend.engine.timeline import TimelineFrame
from backend.workouts.pushup.fsm import (
    DESCENT,
    SETUP,
    AttemptResult,
    PushUpFSM,
    RepState,
    fsm_diagnostics,
)
from backend.workouts.pushup.rules.registry import active_live_rule_modules

#: The template that owns this exercise's range of motion. Named once here rather than repeated as a
#: literal, because every ROM lookup below has to agree with the registry and the config.
ROM_RULE_ID = "pushup_depth"


class PushUpAdapterConfigurationError(ValueError):
    """The persisted baseline or selected push-up rule policy cannot build a safe adapter."""


class PushUpAdapter:
    """Exercise-local coordinator for one push-up set."""

    def __init__(
        self,
        *,
        baseline: dict,
        target_reps: int,
        config: ExerciseConfiguration,
    ) -> None:
        if not isinstance(target_reps, int) or isinstance(target_reps, bool) or target_reps < 1:
            raise PushUpAdapterConfigurationError("target_reps must be a positive integer")
        if not isinstance(baseline, dict):
            raise PushUpAdapterConfigurationError("baseline must be a mapping")

        self._config = config
        self._target_reps = target_reps
        modules = active_live_rule_modules(config)
        self._rules = {
            rule_id: _build_rule(rule_id, module, config.templates[rule_id], baseline)
            for rule_id, module in modules.items()
        }
        self._live_rule_ids = tuple(
            sorted(self._rules, key=lambda rule_id: config.templates[rule_id]["rank"])
        )
        try:
            self._depth = self._rules[ROM_RULE_ID]
        except KeyError as exc:
            raise PushUpAdapterConfigurationError(
                f"push-up requires an active {ROM_RULE_ID} rule"
            ) from exc

        self._fsm = PushUpFSM(
            reached_gate=self._depth.is_full_depth,
            **_fsm_inputs(config),
        )
        self._scorer = RepScorer(config)
        self._timeline = self._scorer.new_timeline()
        self._cue_selector = CueSelector(
            min_display_ms=float(config.scoring["cue_min_display_ms"])
        )
        self._shallow_next_rep_cue_ms = config.templates[ROM_RULE_ID].get(
            "shallow_next_rep_cue_ms"
        )
        self._pending_shallow_depth_cue = False
        self._previous_phase = SETUP
        self._last_attempt: dict | None = None
        self._last_rep: dict | None = None
        self._last_coverage: dict | None = None
        self._scores: list[float] = []
        self._last_rule_results: dict[str, dict] = {}
        self._last_fsm_diagnostics: dict = {}
        self._capture_rollover_pending = False
        self._start_new_capture_rep = False
        self._invalidated: tuple[str, ...] = ()

    @property
    def active_rule_ids(self) -> tuple[str, ...]:
        return self._live_rule_ids

    def debug_snapshot(self) -> dict:
        """Return the capture-only result paired with the most recently processed frame."""
        return {
            "start_new_rep": self._start_new_capture_rep,
            "rules": deepcopy(self._last_rule_results),
            "fsm": deepcopy(self._last_fsm_diagnostics),
        }

    def runtime_metadata(self) -> dict:
        """Snapshot YAML-owned runtime policy without moving configuration into kernels."""
        return {
            "active_rule_ids": list(self.active_rule_ids),
            "templates": deepcopy(self._config.templates),
            "contexts": deepcopy(self._config.contexts),
            "scoring": deepcopy(self._config.scoring),
            "fsm": deepcopy(self._config.fsm),
            "signal_reference": {
                "rule_id": ROM_RULE_ID,
                # Per-side because a profile view only ever shows one arm reliably; which arm is a
                # property of how the user faced the camera, so both are recorded.
                "baseline_elbow_angles_deg": {
                    side: round(angle, 6)
                    for side, angle in self._depth.baseline_elbow_angles_deg.items()
                },
                "target_elbow_angle_deg": self._depth.target_elbow_angle_deg,
                "body_line_baseline_offsets": {
                    side: round(offset, 6)
                    for side, offset in self._body_line_offsets().items()
                },
            },
        }

    def _body_line_offsets(self) -> dict[str, float]:
        rule = self._rules.get("body_line")
        return dict(rule.baseline_offsets) if rule is not None else {}

    def process(self, frame: TrainingFrame) -> dict:
        if not isinstance(frame, TrainingFrame):
            raise TypeError("frame must be a TrainingFrame")

        readings = {
            rule_id: rule.read(frame.keypoints) for rule_id, rule in self._rules.items()
        }
        invalidated = self._invalidating_rules(readings)
        depth_reading = None if invalidated else readings[ROM_RULE_ID]
        if depth_reading is None:
            # No trustworthy ROM signal: the machine pauses rather than guessing, exactly as it does
            # for any other exercise. Monitors that DID read are still reported below, so a user whose
            # arm left frame while also turning front-on still gets the camera cue.
            state = self._fsm.update(None, frame.t_ms)
            rule_states = {rule_id: None for rule_id in self.active_rule_ids}
            self._timeline.push(
                TimelineFrame(frame.t_ms, state.phase, rule_states, tracking=False)
            )
            self._invalidated = invalidated
            issues = self._issues(readings, state.phase, monitors_only=True)
            candidates = [
                CueCandidate(issue["id"], issue["cue"], issue["rank"], coaching=issue["coaching"])
                for issue in issues
            ]
            cue = self._cue_selector.select(candidates, frame.t_ms)
            self._previous_phase = state.phase
            return self._status(state, readings, issues, cue)

        self._invalidated = ()
        state = self._fsm.update(depth_reading.progress, frame.t_ms)
        rule_states = self._rule_states(readings)
        timeline_frame = TimelineFrame(frame.t_ms, state.phase, rule_states, tracking=True)

        if state.attempt_discarded:
            self._timeline = self._scorer.new_timeline()
            self._timeline.push(timeline_frame)
        elif state.attempt_completed:
            evidence = self._timeline.push(timeline_frame, close_rep=True).completed
            if evidence is None or state.completed_attempt is None:
                raise RuntimeError("completed push-up attempt has no timeline evidence")
            score = self._scorer.score(
                CompletedRep(
                    qualified=state.completed_attempt.qualified,
                    rep_peak=state.completed_attempt.peak,
                    evidence=evidence,
                )
            )
            self._record_attempt(state, state.completed_attempt, score)
        else:
            self._timeline.push(timeline_frame)

        issues = self._issues(readings, state.phase)
        candidates = [
            CueCandidate(issue["id"], issue["cue"], issue["rank"], coaching=issue["coaching"])
            for issue in issues
        ]
        if (
            state.completed_attempt is not None
            and state.completed_attempt.classification == "shallow"
        ):
            # A shallow rep is coached on the way into the NEXT rep, where the user can act on it,
            # rather than competing with the cue for the rep they just finished.
            if self._shallow_next_rep_cue_ms is None:
                candidates.append(self._depth_cue())
            elif state.qualified_count < self._target_reps:
                self._pending_shallow_depth_cue = True
        if (
            self._pending_shallow_depth_cue
            and self._previous_phase == SETUP
            and state.phase == DESCENT
        ):
            candidates.append(self._depth_cue(display_ms=float(self._shallow_next_rep_cue_ms)))
            self._pending_shallow_depth_cue = False
        # A rep that did not count (too fast, or short of full range), or a shallow rep that did,
        # is said at once.
        not_counted = rep_outcome.not_counted_cue(
            state.completed_attempt,
            fsm=self._config.fsm,
            rom_rule_id=ROM_RULE_ID,
            rom_template=self._config.templates[ROM_RULE_ID],
        )
        if not_counted is not None:
            candidates.append(not_counted)
        shallow_warning = rep_outcome.shallow_warning_cue(
            state.completed_attempt,
            rom_rule_id=ROM_RULE_ID,
            rom_template=self._config.templates[ROM_RULE_ID],
        )
        if shallow_warning is not None:
            candidates.append(shallow_warning)
        cue = self._cue_selector.select(candidates, frame.t_ms)
        self._previous_phase = state.phase
        return self._status(state, readings, issues, cue)

    def _depth_cue(self, *, display_ms: float | None = None) -> CueCandidate:
        template = self._config.templates[ROM_RULE_ID]
        return CueCandidate(
            ROM_RULE_ID,
            template["cue"],
            template["rank"],
            display_ms=display_ms,
            coaching=template["coaching"],
        )

    def _invalidating_rules(self, readings: dict[str, object | None]) -> tuple[str, ...]:
        """Active rules whose confirmed fault makes this frame unmeasurable rather than merely bad.

        Today that is the side-on camera check alone (`invalidates_measurement` in its template).
        A frame it rejects is handed to the FSM as a tracking loss: the rep machine pauses, nothing
        is scored, and the cue tells the user what to fix — the same treatment as landmarks that
        dropped below confidence, because the consequence is the same.
        """
        return tuple(
            rule_id
            for rule_id in self.active_rule_ids
            if self._config.templates[rule_id].get("invalidates_measurement")
            and readings[rule_id] is not None
            and bool(getattr(readings[rule_id], "not_ok"))
        )

    def _rule_states(self, readings: dict[str, object | None]) -> dict[str, bool | None]:
        states: dict[str, bool | None] = {}
        for rule_id in self._scorer.active_rule_ids:
            reading = readings[rule_id]
            if reading is None:
                states[rule_id] = None
            elif self._config.templates[rule_id]["scoring"]["role"] == "rom":
                states[rule_id] = False
            else:
                states[rule_id] = bool(getattr(reading, "not_ok"))
        return states

    def _issues(
        self,
        readings: dict[str, object | None],
        phase: str,
        *,
        monitors_only: bool = False,
    ) -> list[dict]:
        """Faults to surface this frame.

        ``monitors_only`` is used on a frame with no ROM reading: nothing about the user's form can be
        asserted, but a monitor that DID read (the camera angle) is still worth saying out loud.
        """
        issues: list[dict] = []
        for rule_id in self.active_rule_ids:
            template = self._config.templates[rule_id]
            role = template["scoring"]["role"]
            if role == "rom" or phase not in template["active_phases"]:
                continue
            if monitors_only and role != "monitor":
                continue
            reading = readings[rule_id]
            if reading is None or not bool(getattr(reading, "not_ok")):
                continue
            issues.append(
                {
                    "id": rule_id,
                    "label": template["fault_label"],
                    "tier": template["tier"],
                    "rank": template["rank"],
                    "side": getattr(reading, "side", None),
                    "state": getattr(reading, "state", None),
                    "skeleton_color": getattr(reading, "skeleton_color", None),
                    "cue": template["cue"],
                    "coaching": template.get("coaching"),
                }
            )
        return sorted(issues, key=lambda issue: (issue["rank"], issue["id"]))

    def _record_attempt(
        self,
        state: RepState,
        attempt: AttemptResult,
        score: RepScore,
    ) -> None:
        coverage = _coverage_dict(score.coverage)
        result = {
            "attempt": attempt.number,
            "rep": state.qualified_count if attempt.qualified else None,
            "qualified": attempt.qualified,
            "classification": attempt.classification,
            **rep_outcome.attempt_fields(attempt),
            "peak": attempt.peak,
            "score": score.score,
            "time_score": score.time_score,
            "rom_factor": score.rom_factor,
            "quality": score.quality,
            "scoring_config_version": score.scoring_config_version,
            "score_coverage": coverage,
            "phase_scores": deepcopy(score.phase_scores),
        }
        self._last_attempt = result
        if attempt.qualified:
            self._last_rep = result
            self._last_coverage = coverage
        if attempt.qualified and score.score is not None:
            self._scores.append(score.score)

    def _status(
        self,
        state: RepState,
        readings: dict[str, object | None],
        issues: list[dict],
        cue: CueCandidate | None,
    ) -> dict:
        self._start_new_capture_rep = (
            self._capture_rollover_pending
            and state.phase == SETUP
            and state.qualified_count < self._target_reps
        )
        if self._start_new_capture_rep:
            self._capture_rollover_pending = False
        if state.rep_cycle_completed and state.qualified_count >= self._target_reps:
            self._capture_rollover_pending = False
        self._last_rule_results = self._debug_rule_results(readings, state.phase)
        self._last_fsm_diagnostics = fsm_diagnostics(state)
        if state.attempt_completed or state.attempt_discarded:
            self._capture_rollover_pending = True

        depth = None if self._invalidated else readings[ROM_RULE_ID]
        unavailable = [
            rule_id for rule_id in self.active_rule_ids if readings[rule_id] is None
        ]
        average = round(sum(self._scores) / len(self._scores), 1) if self._scores else None
        return {
            "tracking": {
                "available": depth is not None and not self._invalidated,
                "unavailable_rule_ids": unavailable,
                # Landmarks may be perfectly readable and still not measurable: this names the rule
                # that says so, so the client can tell "we cannot see you" from "we can see you, but
                # not from an angle these measurements mean anything at".
                "invalidated_by": list(self._invalidated),
            },
            "phase": state.phase,
            "counters": rep_outcome.counters(state),
            "rom": {
                "available": depth is not None,
                "ratio": (round(depth.progress, 3) if depth is not None else None),
                "percent": (
                    max(0, min(100, round(depth.progress * 100)))
                    if depth is not None
                    else None
                ),
                "full_rom_gate": self._depth.full_rom_gate,
                "full_depth": (depth.full_depth if depth is not None else None),
                # Push-up-specific extras: the raw elbow angle the signal came from, and which arm
                # the camera could see. Both are what a tuning pass needs to read from a capture.
                "elbow_angle_deg": (depth.elbow_angle_deg if depth is not None else None),
                "analysed_side": (depth.side if depth is not None else None),
                "current_peak": state.current_rep_peak,
                "rule_id": ROM_RULE_ID,
                "coaching": self._config.templates[ROM_RULE_ID]["coaching"],
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
                else {"rule_id": cue.rule_id, "text": cue.text, "coaching": cue.coaching or ""}
            ),
            "last_attempt": self._last_attempt,
            "last_rep": self._last_rep,
            "set": {
                "target_reps": self._target_reps,
                "completed_reps": state.qualified_count,
                "remaining_reps": max(0, self._target_reps - state.qualified_count),
                "complete": state.qualified_count >= self._target_reps,
                "scored_reps": len(self._scores),
                "average_score": average,
            },
            "score_coverage": self._last_coverage,
            "events": {
                "attempt_completed": state.attempt_completed,
                "rep_completed": state.rep_completed,
                "attempt_discarded": state.attempt_discarded,
                "rep_cycle_completed": state.rep_cycle_completed,
                "set_cycle_completed": (
                    state.rep_cycle_completed
                    and state.qualified_count >= self._target_reps
                ),
            },
        }

    def _debug_rule_results(
        self,
        readings: dict[str, object | None],
        phase: str,
    ) -> dict[str, dict]:
        results: dict[str, dict] = {}
        live_context = self._config.contexts["live"]
        ordered = sorted(
            self._config.templates.items(),
            key=lambda item: (item[1]["rank"], item[0]),
        )
        for rule_id, template in ordered:
            active = live_context[rule_id]
            reading = readings.get(rule_id) if active else None
            results[rule_id] = {
                "active": active,
                "phase_active": active and phase in template["active_phases"],
                "evaluated": active,
                "available": active and reading is not None,
                "result": _reading_dict(reading),
            }
        return results


def build_pushup_adapter(
    *,
    baseline: dict,
    target_reps: int,
    config: ExerciseConfiguration | None = None,
) -> PushUpAdapter:
    """Build push-up only from its validated config and the exact persisted set baseline."""
    selected_config = config or load_exercise_config("pushup")
    try:
        return PushUpAdapter(
            baseline=baseline,
            target_reps=target_reps,
            config=selected_config,
        )
    except (KeyError, TypeError, ValueError, RuntimeError) as exc:
        if isinstance(exc, PushUpAdapterConfigurationError):
            raise
        raise PushUpAdapterConfigurationError(str(exc)) from exc


def _build_rule(rule_id: str, module: ModuleType, template: dict, baseline: dict):
    if rule_id == ROM_RULE_ID:
        return module.PushUpDepthRule(
            baseline,
            target_elbow_angle_deg=template["target_elbow_angle_deg"],
            full_rom_gate=template["full_rom_gate"],
            min_baseline_elbow_angle_deg=template["min_baseline_elbow_angle_deg"],
            min_upper_arm_px=template["min_upper_arm_px"],
        )
    if rule_id == "body_line":
        return module.BodyLineRule(
            baseline,
            template["policy"]["mode"],
            template["policy"]["ranges"],
            min_body_span_px=template["min_body_span_px"],
        )
    if rule_id == "side_view_orientation":
        return module.SideViewOrientationRule(
            template["policy"]["ranges"],
            min_torso_length_px=template["min_torso_length_px"],
            confirm_frames=template["confirm_frames"],
            clear_frames=template["clear_frames"],
            hysteresis=True,
        )
    raise PushUpAdapterConfigurationError(f"unsupported active push-up rule: {rule_id}")


def _fsm_inputs(config: ExerciseConfiguration) -> dict:
    values = {
        key: config.fsm[key]
        for key in (
            "phases",
            "initial_phase",
            "transitions",
            "descent_trigger",
            "top_return",
            "min_rep_peak",
            "turnaround_ms",
            "reset_dwell_ms",
            "stale_phase_ms",
        )
    }
    values["max_frame_delta_ms"] = config.scoring["max_frame_delta_ms"]
    values["max_tracking_gap_ms"] = config.fsm.get("max_tracking_gap_ms")
    values.update(rep_outcome.fsm_policy_inputs(config.fsm))
    return values


def _finite(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise PushUpAdapterConfigurationError(f"{name} must be numeric")
    result = float(value)
    if not isfinite(result):
        raise PushUpAdapterConfigurationError(f"{name} must be finite")
    return result


def _coverage_dict(coverage: ScoreCoverage) -> dict:
    return {
        "active_rule_ids": list(coverage.active_rule_ids),
        "available_rule_ids": list(coverage.available_rule_ids),
        "unavailable_rule_ids": list(coverage.unavailable_rule_ids),
        "ratio": coverage.ratio,
        "reliable": coverage.reliable,
    }


def _reading_dict(reading: object | None) -> dict | None:
    if reading is None:
        return None
    if not is_dataclass(reading):
        raise TypeError("rule readings must be dataclass instances")
    return asdict(reading)
