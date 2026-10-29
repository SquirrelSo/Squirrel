"""Squat-specific live adapter: pose frames to phases, reps, scores, issues and cues."""

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
from backend.workouts.squat.fsm import (
    DESCENT,
    SETUP,
    AttemptResult,
    RepState,
    SquatFSM,
    fsm_diagnostics,
)
from backend.workouts.squat.rules.registry import active_live_rule_modules


class SquatAdapterConfigurationError(ValueError):
    """The persisted baseline or selected squat rule policy cannot build a safe adapter."""


class SquatAdapter:
    """Exercise-local coordinator; generic WebSocket code knows none of these squat details."""

    def __init__(
        self,
        *,
        baseline: dict,
        target_reps: int,
        config: ExerciseConfiguration,
    ) -> None:
        if not isinstance(target_reps, int) or isinstance(target_reps, bool) or target_reps < 1:
            raise SquatAdapterConfigurationError("target_reps must be a positive integer")
        if not isinstance(baseline, dict):
            raise SquatAdapterConfigurationError("baseline must be a mapping")

        self._config = config
        self._target_reps = target_reps
        modules = active_live_rule_modules(config)
        self._rules = {
            rule_id: _build_rule(rule_id, module, config.templates[rule_id], baseline)
            for rule_id, module in modules.items()
        }
        self._live_rule_ids = tuple(
            sorted(
                self._rules,
                key=lambda rule_id: config.templates[rule_id]["rank"],
            )
        )
        try:
            self._depth = self._rules["depth"]
        except KeyError as exc:
            raise SquatAdapterConfigurationError("squat requires an active depth rule") from exc

        self._fsm = SquatFSM(
            reached_gate=self._depth.is_full_depth,
            **_fsm_inputs(config),
        )
        self._scorer = RepScorer(config)
        self._timeline = self._scorer.new_timeline()
        self._cue_selector = CueSelector(
            min_display_ms=float(config.scoring["cue_min_display_ms"])
        )
        self._shallow_next_rep_cue_ms = config.templates["depth"].get(
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
                "rule_id": "depth",
                "baseline_hip_y": round(self._depth.baseline_hip_y, 6),
                "baseline_rom_px": round(self._depth.baseline_rom_px, 6),
            },
        }

    def process(self, frame: TrainingFrame) -> dict:
        if not isinstance(frame, TrainingFrame):
            raise TypeError("frame must be a TrainingFrame")

        readings = {
            rule_id: rule.read(frame.keypoints)
            for rule_id, rule in self._rules.items()
        }
        depth_reading = readings["depth"]
        if depth_reading is None:
            state = self._fsm.update(None, frame.t_ms)
            rule_states = {rule_id: None for rule_id in self.active_rule_ids}
            self._timeline.push(
                TimelineFrame(frame.t_ms, state.phase, rule_states, tracking=False)
            )
            issues: list[dict] = []
            cue = self._cue_selector.select([], frame.t_ms)
            self._previous_phase = state.phase
            return self._status(state, readings, issues, cue)

        state = self._fsm.update(depth_reading.depth_ratio, frame.t_ms)
        rule_states = self._rule_states(readings)
        timeline_frame = TimelineFrame(frame.t_ms, state.phase, rule_states, tracking=True)

        if state.attempt_discarded:
            self._timeline = self._scorer.new_timeline()
            self._timeline.push(timeline_frame)
        elif state.attempt_completed:
            evidence = self._timeline.push(timeline_frame, close_rep=True).completed
            if evidence is None or state.completed_attempt is None:
                raise RuntimeError("completed squat attempt has no timeline evidence")
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
            depth_template = self._config.templates["depth"]
            if self._shallow_next_rep_cue_ms is None:
                # Captured pre-version-7 configurations retain their original cue timing.
                candidates.append(
                    CueCandidate(
                        "depth",
                        depth_template["cue"],
                        depth_template["rank"],
                        coaching=depth_template["coaching"],
                    )
                )
            elif state.qualified_count < self._target_reps:
                self._pending_shallow_depth_cue = True
        if (
            self._pending_shallow_depth_cue
            and self._previous_phase == SETUP
            and state.phase == DESCENT
        ):
            depth_template = self._config.templates["depth"]
            candidates.append(
                CueCandidate(
                    "depth",
                    depth_template["cue"],
                    depth_template["rank"],
                    display_ms=float(self._shallow_next_rep_cue_ms),
                    coaching=depth_template["coaching"],
                )
            )
            self._pending_shallow_depth_cue = False
        # A rep that did not count (too fast, or short of full range), or a shallow rep that did,
        # is said at once.
        not_counted = rep_outcome.not_counted_cue(
            state.completed_attempt,
            fsm=self._config.fsm,
            rom_rule_id="depth",
            rom_template=self._config.templates["depth"],
        )
        if not_counted is not None:
            candidates.append(not_counted)
        shallow_warning = rep_outcome.shallow_warning_cue(
            state.completed_attempt,
            rom_rule_id="depth",
            rom_template=self._config.templates["depth"],
        )
        if shallow_warning is not None:
            candidates.append(shallow_warning)
        cue = self._cue_selector.select(candidates, frame.t_ms)
        self._previous_phase = state.phase
        return self._status(state, readings, issues, cue)

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
                    # Setup-only checks carry no coaching; report faults always do.
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
            self._capture_rollover_pending and state.phase == SETUP
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

        depth = readings["depth"]
        unavailable = [
            rule_id for rule_id in self.active_rule_ids if readings[rule_id] is None
        ]
        average = round(sum(self._scores) / len(self._scores), 1) if self._scores else None
        return {
            "tracking": {
                "available": depth is not None,
                "unavailable_rule_ids": unavailable,
            },
            "phase": state.phase,
            "counters": rep_outcome.counters(state),
            "rom": {
                "available": depth is not None,
                "ratio": (round(depth.depth_ratio, 3) if depth is not None else None),
                "percent": (
                    max(0, min(100, round(depth.depth_ratio * 100)))
                    if depth is not None
                    else None
                ),
                "full_rom_gate": self._depth.full_rom_gate,
                "full_depth": (depth.full_depth if depth is not None else None),
                "hip_below_knee": (depth.hip_below_knee if depth is not None else None),
                "current_peak": state.current_rep_peak,
                # The ROM rule id + its coaching so the report can attribute shallow reps without
                # the frontend hardcoding which rule represents range of motion for this exercise.
                "rule_id": "depth",
                "coaching": self._config.templates["depth"]["coaching"],
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


def build_squat_adapter(
    *,
    baseline: dict,
    target_reps: int,
    config: ExerciseConfiguration | None = None,
) -> SquatAdapter:
    """Build squat only from its validated config and the exact persisted set baseline."""
    selected_config = config or load_exercise_config("squat")
    try:
        return SquatAdapter(
            baseline=baseline,
            target_reps=target_reps,
            config=selected_config,
        )
    except (KeyError, TypeError, ValueError, RuntimeError) as exc:
        if isinstance(exc, SquatAdapterConfigurationError):
            raise
        raise SquatAdapterConfigurationError(str(exc)) from exc


def _build_rule(rule_id: str, module: ModuleType, template: dict, baseline: dict):
    if rule_id == "depth":
        hip_y = _midpoint_axis(baseline, "left_hip", "right_hip", "y")
        knee_y = _midpoint_axis(baseline, "left_knee", "right_knee", "y")
        return module.DepthRule(
            hip_y,
            knee_y,
            template["full_rom_gate"],
            min_baseline_span_px=template["min_baseline_span_px"],
        )
    if rule_id == "stance_width":
        return module.StanceWidthRule(
            template["policy"]["ranges"],
            min_shoulder_px=template["min_shoulder_px"],
        )
    if rule_id == "knee_valgus":
        return module.KneeValgusRule(baseline, template["policy"]["ranges"])
    if rule_id == "lateral_torso_lean":
        return module.LateralTorsoLeanRule(
            baseline,
            template["policy"]["mode"],
            template["policy"]["ranges"],
        )
    raise SquatAdapterConfigurationError(f"unsupported active squat rule: {rule_id}")


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


def _midpoint_axis(baseline: dict, left: str, right: str, axis: str) -> float:
    try:
        first = _finite(baseline[left][axis], f"baseline.{left}.{axis}")
        second = _finite(baseline[right][axis], f"baseline.{right}.{axis}")
    except (KeyError, TypeError) as exc:
        raise SquatAdapterConfigurationError(
            f"baseline requires numeric {left}.{axis} and {right}.{axis}"
        ) from exc
    return (first + second) / 2


def _finite(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise SquatAdapterConfigurationError(f"{name} must be numeric")
    result = float(value)
    if not isfinite(result):
        raise SquatAdapterConfigurationError(f"{name} must be finite")
    return result


def _mapping(value: object, name: str) -> dict:
    if not isinstance(value, dict):
        raise SquatAdapterConfigurationError(f"{name} must be a mapping")
    return value


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
