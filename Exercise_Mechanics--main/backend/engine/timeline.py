"""Pure frame timeline with previous-frame attribution and per-rule evidence."""

from __future__ import annotations

from dataclasses import dataclass, field
from math import isfinite
from numbers import Real
from typing import Mapping

from backend.engine.cadence import FrameGapBoundary


@dataclass(frozen=True)
class TimelineFrame:
    """One accepted pose-analysis frame.

    ``rule_states`` uses ``False`` for safe, ``True`` for not-ok and ``None`` (or a missing key)
    for unavailable. Only rules configured on the timeline are inspected.
    """

    t_ms: float
    phase: str
    rule_states: Mapping[str, bool | None]
    tracking: bool = True


@dataclass(frozen=True)
class RuleEvidence:
    """Valid active-window evidence accumulated for one rule during one attempt."""

    active_ms: float = 0.0
    active_frames: int = 0
    not_ok_ms: float = 0.0

    def __post_init__(self) -> None:
        values = (self.active_ms, self.not_ok_ms)
        if any(not isinstance(value, Real) or isinstance(value, bool) for value in values):
            raise ValueError("rule evidence durations must be numeric")
        if any(not isfinite(float(value)) or float(value) < 0 for value in values):
            raise ValueError("rule evidence durations must be finite and non-negative")
        if not isinstance(self.active_frames, int) or isinstance(self.active_frames, bool):
            raise ValueError("rule evidence active_frames must be an integer")
        if self.active_frames < 0:
            raise ValueError("rule evidence active_frames must be non-negative")
        if self.not_ok_ms > self.active_ms:
            raise ValueError("rule evidence not_ok_ms cannot exceed active_ms")

    @property
    def not_ok_fraction(self) -> float:
        if self.active_ms <= 0:
            return 0.0
        return min(1.0, max(0.0, self.not_ok_ms / self.active_ms))


@dataclass(frozen=True)
class RepEvidence:
    """Timeline evidence cut at a rep/attempt boundary."""

    rules: Mapping[str, RuleEvidence]
    phase_ms: Mapping[str, float]
    tracking_gap_count: int
    accepted_frames: int
    started_at_ms: float | None
    ended_at_ms: float | None
    rules_by_phase: Mapping[str, Mapping[str, RuleEvidence]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.rules, Mapping) or any(
            not isinstance(rule_id, str) or not isinstance(value, RuleEvidence)
            for rule_id, value in self.rules.items()
        ):
            raise ValueError("rep evidence rules must map string ids to RuleEvidence")
        if not isinstance(self.phase_ms, Mapping):
            raise ValueError("rep evidence phase_ms must be a mapping")
        for phase, duration in self.phase_ms.items():
            if (
                not isinstance(phase, str)
                or not isinstance(duration, Real)
                or isinstance(duration, bool)
                or not isfinite(float(duration))
                or float(duration) < 0
            ):
                raise ValueError("rep evidence phase durations must be finite and non-negative")
        if not isinstance(self.rules_by_phase, Mapping):
            raise ValueError("rep evidence rules_by_phase must be a mapping")
        for phase, rules in self.rules_by_phase.items():
            if not isinstance(phase, str) or not isinstance(rules, Mapping) or any(
                not isinstance(rule_id, str) or not isinstance(value, RuleEvidence)
                for rule_id, value in rules.items()
            ):
                raise ValueError(
                    "rep evidence rules_by_phase must map phase and rule ids to RuleEvidence"
                )
        for name, value in (
            ("tracking_gap_count", self.tracking_gap_count),
            ("accepted_frames", self.accepted_frames),
        ):
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"rep evidence {name} must be a non-negative integer")
        for name, value in (("started_at_ms", self.started_at_ms), ("ended_at_ms", self.ended_at_ms)):
            if value is not None and (
                not isinstance(value, Real)
                or isinstance(value, bool)
                or not isfinite(float(value))
            ):
                raise ValueError(f"rep evidence {name} must be finite or None")
        if (
            self.started_at_ms is not None
            and self.ended_at_ms is not None
            and self.ended_at_ms < self.started_at_ms
        ):
            raise ValueError("rep evidence cannot end before it starts")


@dataclass(frozen=True)
class TimelineUpdate:
    """Result of pushing one frame into a timeline."""

    accepted: bool
    timestamp_regression: bool
    tracking_gap: bool
    raw_delta_ms: float | None
    effective_delta_ms: float
    credited_delta_ms: float
    completed: RepEvidence | None = None


@dataclass
class _MutableEvidence:
    active_ms: float = 0.0
    active_frames: int = 0
    not_ok_ms: float = 0.0


class RepTimeline:
    """Accumulate active-rule evidence from timestamped frames.

    The interval ending at a frame belongs to the previous accepted frame. A frame marked as a
    boundary therefore closes the preceding interval before the evidence snapshot is cut. The
    boundary frame then becomes the first frame of the next attempt.
    """

    def __init__(
        self,
        active_phases: Mapping[str, set[str] | frozenset[str] | tuple[str, ...] | list[str]],
        *,
        max_frame_delta_ms: float,
        frame_cadence: Mapping | None = None,
    ) -> None:
        if not isinstance(max_frame_delta_ms, Real) or isinstance(max_frame_delta_ms, bool):
            raise ValueError("max_frame_delta_ms must be numeric")
        if not isfinite(float(max_frame_delta_ms)) or float(max_frame_delta_ms) <= 0:
            raise ValueError("max_frame_delta_ms must be finite and positive")
        self._max_delta = float(max_frame_delta_ms)
        # Cadence-aware boundary: identical to max_frame_delta_ms at ~30 fps, scaled with the
        # observed frame interval on slow cameras so normal frames are not read as gaps.
        self._gap_boundary = FrameGapBoundary(self._max_delta, frame_cadence)
        self._active_phases: dict[str, frozenset[str]] = {}
        for rule_id, phases in active_phases.items():
            if not isinstance(rule_id, str) or not rule_id.strip():
                raise ValueError("rule ids must be non-empty strings")
            if isinstance(phases, (str, bytes)):
                raise ValueError(f"active phases for '{rule_id}' must be a collection")
            normalized = frozenset(phases)
            if not normalized or any(not isinstance(phase, str) or not phase for phase in normalized):
                raise ValueError(f"active phases for '{rule_id}' must be non-empty strings")
            self._active_phases[rule_id] = normalized

        self._previous: TimelineFrame | None = None
        self._rules: dict[str, _MutableEvidence] = {}
        self._rules_by_phase: dict[str, dict[str, _MutableEvidence]] = {}
        self._phase_ms: dict[str, float] = {}
        self._tracking_gaps = 0
        self._accepted_frames = 0
        self._started_at_ms: float | None = None

    def push(self, frame: TimelineFrame, *, close_rep: bool = False) -> TimelineUpdate:
        """Accept a frame, optionally cutting the completed attempt at this timestamp."""
        current = self._normalize_frame(frame)
        previous = self._previous
        if previous is None or current.t_ms >= previous.t_ms:
            max_delta = self._gap_boundary.observe(current.t_ms)
        else:
            max_delta = self._gap_boundary.limit_ms
        if previous is None:
            self._previous = current
            self._started_at_ms = current.t_ms
            if close_rep:
                completed = self._snapshot(current.t_ms)
                self._reset(current)
            else:
                self._count_frame(current)
                completed = None
            return TimelineUpdate(True, False, False, None, 0.0, 0.0, completed)

        raw_delta = current.t_ms - previous.t_ms
        if raw_delta < 0:
            return TimelineUpdate(False, True, False, raw_delta, 0.0, 0.0, None)

        effective_delta = min(raw_delta, max_delta)
        tracking_gap = raw_delta > max_delta
        credited_delta = 0.0 if tracking_gap or not previous.tracking else effective_delta
        if tracking_gap:
            self._tracking_gaps += 1
        elif credited_delta > 0:
            self._credit_previous(previous, credited_delta)

        self._previous = current
        if close_rep:
            completed = self._snapshot(current.t_ms)
            self._reset(current)
        else:
            self._count_frame(current)
            completed = None
        return TimelineUpdate(
            True,
            False,
            tracking_gap,
            raw_delta,
            effective_delta,
            credited_delta,
            completed,
        )

    def snapshot(self) -> RepEvidence:
        """Return current evidence without cutting or modifying the timeline."""
        ended_at = self._previous.t_ms if self._previous is not None else None
        return self._snapshot(ended_at)

    def _normalize_frame(self, frame: TimelineFrame) -> TimelineFrame:
        if not isinstance(frame, TimelineFrame):
            raise TypeError("frame must be a TimelineFrame")
        if not isinstance(frame.t_ms, Real) or isinstance(frame.t_ms, bool):
            raise ValueError("frame timestamp must be numeric")
        timestamp = float(frame.t_ms)
        if not isfinite(timestamp):
            raise ValueError("frame timestamp must be finite")
        if not isinstance(frame.phase, str) or not frame.phase:
            raise ValueError("frame phase must be a non-empty string")
        if not isinstance(frame.tracking, bool):
            raise ValueError("frame tracking must be boolean")
        if not isinstance(frame.rule_states, Mapping):
            raise ValueError("frame rule_states must be a mapping")
        states: dict[str, bool | None] = {}
        for rule_id in self._active_phases:
            value = frame.rule_states.get(rule_id)
            if value is not None and not isinstance(value, bool):
                raise ValueError(f"rule state for '{rule_id}' must be boolean or None")
            states[rule_id] = value
        return TimelineFrame(timestamp, frame.phase, states, frame.tracking)

    def _count_frame(self, frame: TimelineFrame) -> None:
        self._accepted_frames += 1
        if not frame.tracking:
            return
        for rule_id, phases in self._active_phases.items():
            if frame.phase in phases and frame.rule_states.get(rule_id) is not None:
                self._rules.setdefault(rule_id, _MutableEvidence()).active_frames += 1
                phase_rules = self._rules_by_phase.setdefault(frame.phase, {})
                phase_rules.setdefault(rule_id, _MutableEvidence()).active_frames += 1

    def _credit_previous(self, frame: TimelineFrame, delta_ms: float) -> None:
        self._phase_ms[frame.phase] = self._phase_ms.get(frame.phase, 0.0) + delta_ms
        for rule_id, phases in self._active_phases.items():
            state = frame.rule_states.get(rule_id)
            if frame.phase not in phases or state is None:
                continue
            evidence = self._rules.setdefault(rule_id, _MutableEvidence())
            evidence.active_ms += delta_ms
            if state:
                evidence.not_ok_ms += delta_ms
            phase_rules = self._rules_by_phase.setdefault(frame.phase, {})
            phase_evidence = phase_rules.setdefault(rule_id, _MutableEvidence())
            phase_evidence.active_ms += delta_ms
            if state:
                phase_evidence.not_ok_ms += delta_ms

    def _snapshot(self, ended_at_ms: float | None) -> RepEvidence:
        rules = {
            rule_id: RuleEvidence(
                active_ms=round(values.active_ms, 6),
                active_frames=values.active_frames,
                not_ok_ms=round(values.not_ok_ms, 6),
            )
            for rule_id, values in self._rules.items()
        }
        rules_by_phase = {
            phase: {
                rule_id: RuleEvidence(
                    active_ms=round(values.active_ms, 6),
                    active_frames=values.active_frames,
                    not_ok_ms=round(values.not_ok_ms, 6),
                )
                for rule_id, values in phase_rules.items()
            }
            for phase, phase_rules in self._rules_by_phase.items()
        }
        return RepEvidence(
            rules=rules,
            phase_ms={phase: round(value, 6) for phase, value in self._phase_ms.items()},
            tracking_gap_count=self._tracking_gaps,
            accepted_frames=self._accepted_frames,
            started_at_ms=self._started_at_ms,
            ended_at_ms=ended_at_ms,
            rules_by_phase=rules_by_phase,
        )

    def _reset(self, first_frame: TimelineFrame) -> None:
        self._rules = {}
        self._rules_by_phase = {}
        self._phase_ms = {}
        self._tracking_gaps = 0
        self._accepted_frames = 0
        self._started_at_ms = first_frame.t_ms
        self._count_frame(first_frame)
