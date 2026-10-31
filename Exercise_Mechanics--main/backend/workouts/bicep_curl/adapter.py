"""Bicep curl live adapter: pose frames to phases, reps, scores, issues and cues.

Mirrors the squat adapter's orchestration (timeline, scorer, cue selector, capture rollover). Curl
specifics: dual-arm `curl_rom` (body-relative wrist height against the captured resting hang and
shoulder target) drives the FSM, while
`elbow_flare_corridor`, `lateral_torso_lean` and `shoulder_elevation` follow the same
baseline-relative penalty-rule path used by squat. The persisted baseline supplies all rules'
person-specific references.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, is_dataclass
from types import ModuleType

from backend.core.frame import TrainingFrame
from backend.engine.cues import CueCandidate, CueSelector
from backend.engine import rep_outcome
from backend.engine.loader import ExerciseConfiguration, load_exercise_config
from backend.engine.rep_fsm import (
    AttemptResult,
    RepFSM,
    RepObservation,
    RepState,
    fsm_diagnostics,
)
from backend.engine.scorer import CompletedRep, RepScore, RepScorer, ScoreCoverage
from backend.engine.timeline import TimelineFrame
from backend.workouts.bicep_curl.rules.registry import active_live_rule_modules

# Curl phase vocabulary the adapter references directly: the shallow next-rep reminder fires on the
# setup→ascent boundary (ascent is curl's first movement phase). The generic RepFSM never hard-codes
# these; it derives its lifecycle roles from the transition graph.
SETUP, ASCENT = "setup", "ascent"


class BicepCurlAdapterConfigurationError(ValueError):
    """The selected bicep curl rule policy cannot build a safe adapter."""


class BicepCurlAdapter:
    """Exercise-local coordinator; generic WebSocket code knows none of these curl details."""

    def __init__(
        self,
        *,
        baseline: dict,
        target_reps: int,
        config: ExerciseConfiguration,
        variant: str | None = None,
    ) -> None:
        if not isinstance(target_reps, int) or isinstance(target_reps, bool) or target_reps < 1:
            raise BicepCurlAdapterConfigurationError("target_reps must be a positive integer")
        if variant not in (None, "single", "double"):
            raise BicepCurlAdapterConfigurationError("variant must be 'single', 'double' or None")
        # The planned curl (session plan): "double" needs both arms through every rep, "single"
        # counts the working arm and says so when both arms curl. None (older sessions): either.
        self._variant = variant
        if not isinstance(baseline, dict):
            raise BicepCurlAdapterConfigurationError("baseline must be a mapping")

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
            self._rom = self._rules["curl_rom"]
        except KeyError as exc:
            raise BicepCurlAdapterConfigurationError(
                "bicep curl requires an active curl_rom rule"
            ) from exc

        fsm_inputs = _fsm_inputs(config)
        # The same configured boundaries the FSM uses, applied to the leading arm.
        self._descent_trigger = float(fsm_inputs["descent_trigger"])
        self._top_return = float(fsm_inputs["top_return"])
        self._fsm = RepFSM(
            reached_gate=self._rom.is_full_rom,
            **fsm_inputs,
        )
        self._scorer = RepScorer(config)
        self._timeline = self._scorer.new_timeline()
        self._cue_selector = CueSelector(
            min_display_ms=float(config.scoring["cue_min_display_ms"])
        )
        self._shallow_next_rep_cue_ms = config.templates["curl_rom"].get(
            "shallow_next_rep_cue_ms"
        )
        self._pending_shallow_cue = False
        self._previous_phase = SETUP
        self._last_attempt: dict | None = None
        self._last_rep: dict | None = None
        self._last_coverage: dict | None = None
        self._scores: list[float] = []
        self._last_rule_results: dict[str, dict] = {}
        self._last_fsm_diagnostics: dict = {}
        # Per-arm peaks for the attempt in flight. The FSM only ever sees min(left, right), so
        # without these a capture cannot say WHICH arm limited a shallow rep.
        self._arm_peaks = _empty_arm_peaks()
        # The highest point BOTH arms reached together this attempt, from frames where both were
        # measured (single-arm plan: both arms curling is the wrong exercise).
        self._both_arms_peak = 0.0
        self._capture_rollover_pending = False
        self._start_new_capture_rep = False

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
        # Only the ROM rule is guaranteed present — the adapter refuses to build without it. Every
        # other rule is switchable in switches.yaml, which is how a `development` template runs dark
        # while its bands are still being tuned, so its reference is recorded only when it is active.
        signal_reference = {
            "rule_id": "curl_rom",
            "rest_offset": {
                side: round(self._rom.rest_offset(side), 6) for side in ("left", "right")
            },
            "upper_arm_px": {
                side: round(self._rom.baseline_upper_arm_px(side), 6)
                for side in ("left", "right")
            },
        }
        shoulder_elevation = self._rules.get("shoulder_elevation")
        if shoulder_elevation is not None:
            reference = shoulder_elevation.baseline
            signal_reference["shoulder_elevation"] = {
                "height": {
                    "left": round(reference.left_height, 6),
                    "right": round(reference.right_height, 6),
                },
                "curl_height": round(reference.own_curl_height, 6),
                "shoulder_width_px": round(reference.shoulder_width_px, 6),
                "torso_length_px": round(reference.torso_length_px, 6),
            }
        elbow_flare = self._rules.get("elbow_flare_corridor")
        if elbow_flare is not None:
            signal_reference["elbow_flare_corridor"] = {
                "baseline_offset": {
                    side: round(elbow_flare.baseline_offset(side), 6)
                    for side in ("left", "right")
                },
                "shoulder_width_px": round(
                    elbow_flare.baseline_shoulder_width_px, 6
                ),
                "torso_length_px": round(
                    elbow_flare.baseline_torso_length_px, 6
                ),
            }
        lateral_lean = self._rules.get("lateral_torso_lean")
        if lateral_lean is not None:
            signal_reference["lateral_torso_lean"] = {
                "baseline_angle_deg": round(lateral_lean.baseline_angle_deg, 6)
            }
        return {
            "active_rule_ids": list(self.active_rule_ids),
            "templates": deepcopy(self._config.templates),
            "contexts": deepcopy(self._config.contexts),
            "scoring": deepcopy(self._config.scoring),
            "fsm": deepcopy(self._config.fsm),
            "signal_reference": signal_reference,
        }

    def process(self, frame: TrainingFrame) -> dict:
        if not isinstance(frame, TrainingFrame):
            raise TypeError("frame must be a TrainingFrame")

        readings = {
            rule_id: rule.read(frame.keypoints)
            for rule_id, rule in self._rules.items()
        }
        rom_reading = readings["curl_rom"]
        if rom_reading is None:
            state = self._fsm.update(None, frame.t_ms)
            rule_states = {rule_id: None for rule_id in self.active_rule_ids}
            self._timeline.push(
                TimelineFrame(frame.t_ms, state.phase, rule_states, tracking=False)
            )
            issues: list[dict] = []
            cue = self._cue_selector.select([], frame.t_ms)
            self._previous_phase = state.phase
            return self._status(state, readings, issues, cue)

        state = self._fsm.update(self._observation(rom_reading), frame.t_ms)
        self._arm_peaks = {
            "left": max(self._arm_peaks["left"], rom_reading.left_ratio),
            "right": max(self._arm_peaks["right"], rom_reading.right_ratio),
        }
        both_seen = rom_reading.arms_seen == "both"
        if both_seen and state.phase != SETUP:
            self._both_arms_peak = max(
                self._both_arms_peak, min(rom_reading.left_ratio, rom_reading.right_ratio)
            )
        rule_states = self._rule_states(readings)
        timeline_frame = TimelineFrame(frame.t_ms, state.phase, rule_states, tracking=True)

        if state.attempt_discarded:
            self._timeline = self._scorer.new_timeline()
            self._timeline.push(timeline_frame)
        elif state.attempt_completed:
            evidence = self._timeline.push(timeline_frame, close_rep=True).completed
            if evidence is None or state.completed_attempt is None:
                raise RuntimeError("completed curl attempt has no timeline evidence")
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
        rom_template = self._config.templates["curl_rom"]
        if (
            state.completed_attempt is not None
            and state.completed_attempt.classification == "shallow"
        ):
            if self._shallow_next_rep_cue_ms is None:
                candidates.append(
                    CueCandidate(
                        "curl_rom",
                        rom_template["cue"],
                        rom_template["rank"],
                        coaching=rom_template["coaching"],
                    )
                )
            elif state.qualified_count < self._target_reps:
                self._pending_shallow_cue = True
        if (
            self._pending_shallow_cue
            and self._previous_phase == SETUP
            and state.phase == ASCENT
        ):
            candidates.append(
                CueCandidate(
                    "curl_rom",
                    rom_template["cue"],
                    rom_template["rank"],
                    display_ms=float(self._shallow_next_rep_cue_ms),
                    coaching=rom_template["coaching"],
                )
            )
            self._pending_shallow_cue = False
        variant_cue = self._variant_cue(state, rom_reading, both_seen)
        if variant_cue is not None:
            candidates.append(variant_cue)
        # A rep that did not count (too fast, or short of full range), or a shallow rep that did,
        # is said at once.
        not_counted = rep_outcome.not_counted_cue(
            state.completed_attempt,
            fsm=self._config.fsm,
            rom_rule_id="curl_rom",
            rom_template=self._config.templates["curl_rom"],
        )
        if not_counted is not None:
            candidates.append(not_counted)
        shallow_warning = rep_outcome.shallow_warning_cue(
            state.completed_attempt,
            rom_rule_id="curl_rom",
            rom_template=self._config.templates["curl_rom"],
        )
        if shallow_warning is not None:
            candidates.append(shallow_warning)
        cue = self._cue_selector.select(candidates, frame.t_ms)
        self._previous_phase = state.phase
        return self._status(state, readings, issues, cue)

    def _variant_cue(self, state, reading, both_seen: bool) -> CueCandidate | None:
        """Say when the arms do not match the planned curl (field test: a single-arm plan counted
        double-arm reps with no word about it)."""
        cues = self._config.templates["curl_rom"].get("variant_cues") or {}
        if self._variant == "single" and state.attempt_completed:
            both = self._both_arms_peak >= self._config.templates["curl_rom"]["full_rom_gate"] / 2
            self._both_arms_peak = 0.0
            if both and cues.get("single"):
                return CueCandidate("curl_variant", cues["single"], 1, display_ms=2500.0)
        if state.attempt_discarded:
            self._both_arms_peak = 0.0
        if (
            self._variant == "double"
            and both_seen
            and state.phase == SETUP
            and reading.leading_ratio >= float(self._config.fsm["min_rep_peak"])
            and min(reading.left_ratio, reading.right_ratio) <= self._descent_trigger
            and cues.get("double")
        ):
            # One arm is curling and the other has not left rest: a double curl never starts.
            return CueCandidate("curl_variant", cues["double"], 1, display_ms=2500.0)
        return None

    def _observation(self, reading) -> RepObservation:
        """Turn one curl frame into the movement facts the FSM acts on.

        Double-arm plan: the WEAKER arm drives the rep (`min`): it starts when both arms leave rest
        and reaches full range only when both do, and it is over once both are back down (`max`).
        Otherwise everything follows the leading arm (`max`): the movement is under way as soon as
        either arm leaves rest, reaches full range when either arm does, and is over once the
        higher arm is back down. A hidden arm reads as the visible one (rules/curl_rom.py)."""
        if self._variant == "double":
            weaker = min(reading.left_ratio, reading.right_ratio)
            return RepObservation(
                progress=weaker,
                movement_started=weaker > self._descent_trigger,
                full_rom_reached=self._rom.is_full_rom(weaker),
                returned_to_rest=reading.leading_ratio < self._top_return,
            )
        return RepObservation(
            progress=reading.progress,
            movement_started=reading.leading_ratio > self._descent_trigger,
            full_rom_reached=reading.full_rom,
            returned_to_rest=reading.leading_ratio < self._top_return,
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

    def _issues(self, readings: dict[str, object | None], phase: str) -> list[dict]:
        issues: list[dict] = []
        for rule_id in self.active_rule_ids:
            template = self._config.templates[rule_id]
            if template["scoring"]["role"] == "rom" or phase not in template["active_phases"]:
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
            # Which arm actually limited this rep — the weaker-arm scalar alone cannot say.
            "arm_peaks": {side: round(peak, 3) for side, peak in self._arm_peaks.items()},
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
            self._capture_rollover_pending and state.phase == SETUP
            and state.qualified_count < self._target_reps
        )
        if self._start_new_capture_rep:
            self._capture_rollover_pending = False
        if state.rep_cycle_completed and state.qualified_count >= self._target_reps:
            self._capture_rollover_pending = False
        self._last_rule_results = self._debug_rule_results(readings, state.phase)
        self._last_fsm_diagnostics = fsm_diagnostics(state, arm_peaks={side: round(peak, 3) for side, peak in self._arm_peaks.items()})
        if state.attempt_completed or state.attempt_discarded:
            self._capture_rollover_pending = True
            self._arm_peaks = _empty_arm_peaks()

        rom = readings["curl_rom"]
        unavailable = [
            rule_id for rule_id in self.active_rule_ids if readings[rule_id] is None
        ]
        average = round(sum(self._scores) / len(self._scores), 1) if self._scores else None
        return {
            "tracking": {
                "available": rom is not None,
                "unavailable_rule_ids": unavailable,
            },
            "phase": state.phase,
            "counters": rep_outcome.counters(state),
            "rom": {
                "available": rom is not None,
                "ratio": (round(rom.progress, 3) if rom is not None else None),
                "percent": _percent(rom.progress) if rom is not None else None,
                "full_rom_gate": self._rom.full_rom_gate,
                "full_rom": (rom.full_rom if rom is not None else None),
                # Per-arm detail so coaching can name the arm that curled less; the leading arm is the signal.
                "left_ratio": (round(rom.left_ratio, 3) if rom is not None else None),
                "right_ratio": (round(rom.right_ratio, 3) if rom is not None else None),
                "left_percent": _percent(rom.left_ratio) if rom is not None else None,
                "right_percent": _percent(rom.right_ratio) if rom is not None else None,
                "left_full": (rom.left_full if rom is not None else None),
                "right_full": (rom.right_full if rom is not None else None),
                "weaker_side": (rom.weaker_side if rom is not None else None),
                "current_peak": state.current_rep_peak,
                # The ROM rule id + coaching so the report can attribute shallow reps without the
                # frontend hardcoding which rule represents range of motion for this exercise.
                "rule_id": "curl_rom",
                "coaching": self._config.templates["curl_rom"]["coaching"],
            },
            "active_rule_ids": list(self.active_rule_ids),
            "issues": [
                {key: value for key, value in issue.items() if key not in {"rank", "cue", "coaching"}}
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


def build_bicep_curl_adapter(
    *,
    baseline: dict,
    target_reps: int,
    config: ExerciseConfiguration | None = None,
    variant: str | None = None,
) -> BicepCurlAdapter:
    """Build bicep curl from its validated config and per-set body-relative wrist references."""
    selected_config = config or load_exercise_config("bicep_curl")
    try:
        return BicepCurlAdapter(
            baseline=baseline,
            target_reps=target_reps,
            config=selected_config,
            variant=variant,
        )
    except (KeyError, TypeError, ValueError, RuntimeError) as exc:
        if isinstance(exc, BicepCurlAdapterConfigurationError):
            raise
        raise BicepCurlAdapterConfigurationError(str(exc)) from exc


def _build_rule(rule_id: str, module: ModuleType, template: dict, baseline: dict):
    if rule_id == "lateral_torso_lean":
        return module.LateralTorsoLeanRule(
            baseline,
            template["policy"]["mode"],
            template["policy"]["ranges"],
            min_torso_length_px=template["min_torso_length_px"],
        )
    if rule_id == "elbow_flare_corridor":
        return module.ElbowFlareRule(
            baseline,
            template["policy"]["mode"],
            template["policy"]["ranges"],
            min_shoulder_width_px=template["min_shoulder_width_px"],
            min_torso_length_px=template["min_torso_length_px"],
        )
    if rule_id == "shoulder_elevation":
        return module.ShoulderElevationRule(
            baseline,
            template["policy"]["mode"],
            template["policy"]["ranges"],
            min_shoulder_width_px=template["min_shoulder_width_px"],
            min_torso_length_px=template["min_torso_length_px"],
            curl_height_slope=template["curl_height_slope"],
        )
    if rule_id == "curl_rom":
        return module.CurlRomRule(
            baseline,
            template["target_offset"],
            template["full_rom_gate"],
            min_upper_arm_px=template["min_upper_arm_px"],
        )
    raise BicepCurlAdapterConfigurationError(f"unsupported active curl rule: {rule_id}")


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
    values["frame_cadence"] = config.scoring.get("frame_cadence")
    return values


def _empty_arm_peaks() -> dict[str, float]:
    return {"left": 0.0, "right": 0.0}


def _percent(ratio: float) -> int:
    return max(0, min(100, round(ratio * 100)))


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
