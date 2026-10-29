"""Exercise-agnostic repetition taxonomy and phase state machine.

The machine consumes one normalized movement-progress signal: the resting position is near zero
and progress grows toward the peak of the rep (squat depth, elbow flexion, …). Biomechanics remain
in the exercise's signal kernel. This module owns only movement history, attempt qualification and
full-versus-shallow classification.

One configuration-supplied predicate is the full-ROM authority. The same predicate controls both
entry into the peak phase and the completed-rep verdict. ``min_rep_peak`` is a lower qualification
boundary: rep-shaped movements below it are diagnostic invalid attempts and never advance the set.

Two optional policies decide what else a rep must be to count. ``count_shallow: false`` makes a rep
that passed ``min_rep_peak`` but missed the full-ROM gate an invalid attempt (reason ``shallow``)
instead of a counted shallow rep. ``min_rep_ms`` is the shortest believable movement, from leaving
the resting band to returning to it: a faster one is an invalid attempt (reason ``too_fast``). Both
stay visible (``AttemptResult.reason`` and the not-counted counters); neither advances the set.

Phase names are not fixed here. The lifecycle roles (the resting/``setup`` phase, the ``reset``
dwell phase, the movement phases and which movement phase is the returning one) are derived from
the configured transition graph, so a descend-first squat and an ascend-first curl share this exact
machine with different phase vocabularies.

Tracking-unavailable frames pause the machine. A short gap can resume only when the recovered
progress is compatible with the prior phase. A long or incompatible gap discards the partial
movement and requires a fresh resting setup frame. Stale time can also discard a movement, but it
never fabricates a completed rep.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from numbers import Real
from typing import Callable, Literal, Mapping

from backend.engine.cadence import FrameGapBoundary

_CONDITIONS = frozenset(
    {
        "tracking_recovery_failed",
        "phase_stale",
        "descent_started",
        "full_rom_reached",
        "turnaround_confirmed",
        "top_returned",
        "reset_dwell_elapsed",
    }
)
_ACTIONS = frozenset({"complete_attempt", "discard_attempt", "reset_attempt"})
_EVENTS = frozenset({"attempt_completed", "attempt_discarded", "rep_cycle_completed"})

AttemptClassification = Literal["invalid", "shallow", "full_rom"]
# Why an attempt did not count: under min_rep_peak, faster than min_rep_ms, or short of the full-ROM
# gate while shallow reps do not count.
InvalidReason = Literal["below_min_peak", "too_fast", "shallow"]


@dataclass(frozen=True)
class AttemptResult:
    """One verified rep-shaped movement that turned and returned to the top."""

    number: int
    peak: float
    qualified: bool
    classification: AttemptClassification
    reason: InvalidReason | None = None
    # Leaving the resting band to returning to it (ms); None when the start was not observed.
    duration_ms: float | None = None

    @property
    def full_rom(self) -> bool:
        return self.classification == "full_rom"

    @property
    def shallow(self) -> bool:
        return self.classification == "shallow"


@dataclass(frozen=True)
class RepObservation:
    """What one frame says about the movement, as the facts the machine acts on.

    A single-signal exercise (squat depth) can describe a frame with one number, and
    ``from_scalar`` builds exactly that. A MULTI-LIMB exercise cannot: a double-arm curl reaches
    full ROM only when BOTH arms reach the gate, but has returned to rest only when BOTH arms are
    down. Those are opposite reductions of the same pair — ``min`` on the way up, ``max`` on the way
    back — so no single scalar can carry both, and an exercise that tried would end its reps as soon
    as the FIRST limb came down.

    Each fact therefore arrives already decided by the exercise, which is the only layer that knows
    what its limbs mean. ``progress`` remains one number because peak tracking, classification and
    scoring are inherently scalar: it is the movement's own headline value (the weaker arm, for a
    curl), not a re-derivation of the booleans.
    """

    progress: float
    movement_started: bool    # has the movement left the resting band
    full_rom_reached: bool    # has the full-ROM gate been satisfied
    returned_to_rest: bool    # has the movement come back to rest

    @classmethod
    def from_scalar(
        cls,
        progress: float,
        *,
        descent_trigger: float,
        top_return: float,
        reached_gate: Callable[[float], bool],
    ) -> "RepObservation":
        """The single-signal case, where one value answers all three questions."""
        return cls(
            progress=progress,
            movement_started=progress > descent_trigger,
            full_rom_reached=reached_gate(progress),
            returned_to_rest=progress < top_return,
        )


@dataclass(frozen=True)
class RepState:
    """The authoritative FSM snapshot after one input frame."""

    phase: str
    progress: float | None
    tracking: bool
    attempt_count: int
    qualified_count: int
    full_rom_count: int
    shallow_count: int
    invalid_attempt_count: int
    current_rep_peak: float
    attempt_completed: bool
    rep_completed: bool
    attempt_discarded: bool
    rep_cycle_completed: bool
    completed_attempt: AttemptResult | None
    shallow_flag: bool
    # Diagnostics, for offline capture analysis only — nothing in the engine reads these back.
    # `conditions` is what the progress-based predicates said on THIS frame, so a reviewer can see
    # whether a transition was driven by a sustained movement or by a single noisy frame — the
    # measurement any dwell/hysteresis tuning has to start from. `fired_transitions` records what
    # actually ran, in order, since several can fire within one frame.
    conditions: dict[str, bool]
    fired_transitions: tuple[dict[str, str], ...]
    # Invalid attempts that were full enough to be reps but did not count (included in
    # invalid_attempt_count): short of the full-ROM gate, or too fast.
    shallow_not_counted: int = 0
    too_fast_count: int = 0

    @property
    def rep_count(self) -> int:
        """Compatibility alias: the set counter advances on qualified reps only."""
        return self.qualified_count


def fsm_diagnostics(state: RepState, **extra: object) -> dict:
    """The per-frame FSM instrumentation written into a capture (never sent over the socket).

    Kept next to the machine that produces it so both adapters record the same shape and offline
    analysis can read any exercise's capture the same way. `extra` carries exercise-specific
    diagnostics (curl's per-arm peaks) without the engine needing to know what they are."""
    return {
        "phase": state.phase,
        "tracking": state.tracking,
        "progress": state.progress,
        "current_rep_peak": state.current_rep_peak,
        "conditions": dict(state.conditions),
        "fired_transitions": [dict(transition) for transition in state.fired_transitions],
        **extra,
    }


class RepFSM:
    """Exercise-agnostic rep FSM driven entirely by configuration-supplied boundaries.

    ``max_frame_delta_ms`` is shared with the evidence timeline. It distinguishes a resumable
    tracking interruption from a long gap, unless the exercise configures a longer
    ``max_tracking_gap_ms`` (slow cameras, a joint hidden for a moment). When ``frame_cadence`` is
    configured the boundary also scales with the observed frame interval (see ``engine/cadence.py``)
    so a slow phone camera is not read as lost tracking; the larger of the two applies. No other
    constructor tunable has a code default. The lifecycle
    roles (resting/setup phase, reset phase, movement phases and the single returning phase) are
    derived from the transition graph so no phase name is hard-coded.
    """

    def __init__(
        self,
        reached_gate: Callable[[float], bool],
        *,
        phases: list[str],
        initial_phase: str,
        transitions: list[dict],
        descent_trigger: float,
        top_return: float,
        min_rep_peak: float,
        turnaround_ms: float,
        reset_dwell_ms: float,
        stale_phase_ms: float,
        max_frame_delta_ms: float,
        max_tracking_gap_ms: float | None = None,
        count_shallow: bool = True,
        min_rep_ms: float | None = None,
        frame_cadence: Mapping | None = None,
    ) -> None:
        if not callable(reached_gate):
            raise ValueError("reached_gate must be callable")
        self._reached_gate = reached_gate
        if (
            not isinstance(phases, list)
            or not phases
            or any(not isinstance(phase, str) for phase in phases)
            or len(set(phases)) != len(phases)
        ):
            raise ValueError("phases must be a unique non-empty list")
        if initial_phase not in phases:
            raise ValueError("initial_phase must be configured in phases")
        self._phases = tuple(phases)
        self._transitions = self._build_transitions(transitions)
        self._setup_phase, self._reset_phase, self._moving_phases, self._returning_phase = (
            self._derive_phase_roles(initial_phase)
        )
        self._descent_trigger = _finite(descent_trigger, "descent_trigger")
        self._top_return = _finite(top_return, "top_return")
        self._min_rep_peak = _positive(min_rep_peak, "min_rep_peak")
        self._turnaround_ms = _positive(turnaround_ms, "turnaround_ms")
        self._reset_dwell_ms = _positive(reset_dwell_ms, "reset_dwell_ms")
        self._stale_phase_ms = _positive(stale_phase_ms, "stale_phase_ms")
        self._max_frame_delta_ms = _positive(max_frame_delta_ms, "max_frame_delta_ms")
        self._max_tracking_gap_ms = (
            self._max_frame_delta_ms
            if max_tracking_gap_ms is None
            else _positive(max_tracking_gap_ms, "max_tracking_gap_ms")
        )
        if not isinstance(count_shallow, bool):
            raise ValueError("count_shallow must be boolean")
        self._count_shallow = count_shallow
        self._min_rep_ms = None if min_rep_ms is None else _positive(min_rep_ms, "min_rep_ms")
        # Adaptive to the camera's frame rate; the fixed max_tracking_gap_ms still applies on top.
        self._gap_boundary = FrameGapBoundary(self._max_frame_delta_ms, frame_cadence)
        if not 0 <= self._top_return <= self._descent_trigger < self._min_rep_peak:
            raise ValueError(
                "progress thresholds must satisfy "
                "0 <= top_return <= descent_trigger < min_rep_peak"
            )

        self._attempt_count = 0
        self._qualified_count = 0
        self._full_rom_count = 0
        self._shallow_count = 0
        self._invalid_attempt_count = 0
        self._shallow_not_counted = 0
        self._too_fast_count = 0
        self._shallow_flag = False
        self._attempt_started_ms: float | None = None

        self._phase = initial_phase
        self._phase_entered_ms: float | None = None
        self._peak = 0.0
        self._peak_at_ms: float | None = None
        self._setup_armed = False

        self._last_seen_ms: float | None = None
        self._last_tracked_ms: float | None = None
        self._tracking_paused = False

        self._completed_attempt_event: AttemptResult | None = None
        self._emitted_events: set[str] = set()
        self._fired_transitions: list[dict[str, str]] = []

    def update(
        self,
        observation: "RepObservation | float | None",
        now_ms: float,
    ) -> RepState:
        """Process one frame's observation, or ``None`` when required tracking is unavailable.

        A bare float is accepted and read as a single-signal observation. That is not a
        compatibility shim: for an exercise whose movement IS one number, the scalar carries the
        whole truth, and deriving the three facts here keeps that exercise from restating them."""
        timestamp = _finite(now_ms, "now_ms")
        value = None if observation is None else self._observe(observation)
        if self._last_seen_ms is not None and timestamp < self._last_seen_ms:
            raise ValueError("now_ms must be monotonic")
        self._last_seen_ms = timestamp
        gap_limit_ms = max(self._max_tracking_gap_ms, self._gap_boundary.observe(timestamp))
        self._completed_attempt_event = None
        self._emitted_events = set()
        self._fired_transitions = []

        if value is None:
            self._tracking_paused = True
            return self._state(None, tracking=False)

        if self._last_tracked_ms is not None:
            gap_ms = timestamp - self._last_tracked_ms
            if gap_ms > gap_limit_ms or (
                self._tracking_paused and not self._recovery_is_compatible(value.progress)
            ):
                if not self._apply_configured_transition(
                    "tracking_recovery_failed", value, timestamp
                ):
                    raise RuntimeError(
                        f"no tracking_recovery_failed transition configured for {self._phase}"
                    )
            elif self._tracking_paused:
                self._shift_phase_clocks(gap_ms)

        self._tracking_paused = False
        self._last_tracked_ms = timestamp
        self._step(value, timestamp)

        if self._phase in self._moving_phases and value.progress > self._peak:
            self._peak = value.progress
            self._peak_at_ms = timestamp

        return self._state(value, tracking=True)

    def _observe(self, observation: "RepObservation | float") -> RepObservation:
        if isinstance(observation, RepObservation):
            _finite(observation.progress, "progress")
            return observation
        return RepObservation.from_scalar(
            _finite(observation, "progress"),
            descent_trigger=self._descent_trigger,
            top_return=self._top_return,
            reached_gate=self._reached_gate,
        )

    def _step(self, observation: RepObservation, now_ms: float) -> None:
        # Transitions are acyclic within a frame. The structural cap protects future edits from
        # accidentally creating an infinite loop. Its bound comes from configured phases.
        for _ in range(len(self._phases) + 1):
            if self._phase == self._setup_phase and not self._setup_armed:
                # Arming is the exact complement of movement: a new attempt may only begin once
                # the movement is genuinely back at rest.
                if not observation.movement_started:
                    self._setup_armed = True
            transition = next(
                (
                    item
                    for item in self._transitions[self._phase]
                    if self._condition_met(item["when"], observation, now_ms)
                ),
                None,
            )
            if transition is None:
                break
            self._execute_transition(transition, now_ms)
            if "attempt_discarded" in self._emitted_events:
                break
        else:
            raise RuntimeError("configured FSM transitions did not settle within one frame")

    def _condition_met(
        self,
        condition: str,
        observation: RepObservation,
        now_ms: float,
    ) -> bool:
        if condition == "tracking_recovery_failed":
            return False
        if condition == "phase_stale":
            return self._phase_is_stale(now_ms)
        if condition == "descent_started":
            return self._setup_armed and observation.movement_started
        if condition == "full_rom_reached":
            return observation.full_rom_reached
        if condition == "turnaround_confirmed":
            # Deliberately reads `progress`, not a boolean: a turnaround is defined against the
            # peak this machine is tracking, and that peak is the scalar.
            return self._is_turnaround(observation.progress, now_ms)
        if condition == "top_returned":
            return observation.returned_to_rest
        if condition == "reset_dwell_elapsed":
            return bool(
                self._phase_entered_ms is not None
                and now_ms - self._phase_entered_ms >= self._reset_dwell_ms
            )
        raise RuntimeError(f"unsupported FSM condition: {condition}")

    def _apply_configured_transition(
        self,
        condition: str,
        observation: RepObservation,
        now_ms: float,
    ) -> bool:
        del observation  # External conditions are selected explicitly by the caller.
        transition = next(
            (
                item
                for item in self._transitions[self._phase]
                if item["when"] == condition
            ),
            None,
        )
        if transition is None:
            return False
        self._execute_transition(transition, now_ms)
        return True

    def _execute_transition(self, transition: dict, now_ms: float) -> None:
        self._fired_transitions.append(
            {
                "from": self._phase,
                "to": transition["to"],
                "when": transition["when"],
            }
        )
        if self._phase == self._setup_phase and transition["to"] in self._moving_phases:
            self._attempt_started_ms = now_ms
        action = transition.get("action")
        if action == "complete_attempt":
            self._complete_attempt(now_ms)
        elif action == "discard_attempt":
            self._reset_attempt()
        elif action == "reset_attempt":
            self._reset_attempt()
        elif action is not None:
            raise RuntimeError(f"unsupported FSM action: {action}")

        self._phase = transition["to"]
        self._phase_entered_ms = now_ms
        event = transition.get("emit")
        if event is not None:
            self._emitted_events.add(event)

    def _is_turnaround(self, progress: float, now_ms: float) -> bool:
        if self._peak_at_ms is None or progress >= self._peak:
            return False
        return now_ms - self._peak_at_ms >= self._turnaround_ms

    def _complete_attempt(self, now_ms: float) -> None:
        self._attempt_count += 1
        duration = (
            None if self._attempt_started_ms is None else now_ms - self._attempt_started_ms
        )
        full = self._reached_gate(self._peak)
        reason: InvalidReason | None = None
        if self._peak < self._min_rep_peak:
            reason = "below_min_peak"
        elif self._min_rep_ms is not None and duration is not None and duration < self._min_rep_ms:
            reason = "too_fast"
            self._too_fast_count += 1
        elif not full and not self._count_shallow:
            reason = "shallow"
            self._shallow_not_counted += 1
            self._shallow_flag = True

        qualified = reason is None
        if not qualified:
            classification: AttemptClassification = "invalid"
            self._invalid_attempt_count += 1
        elif full:
            classification = "full_rom"
            self._qualified_count += 1
            self._full_rom_count += 1
            self._shallow_flag = False
        else:
            classification = "shallow"
            self._qualified_count += 1
            self._shallow_count += 1
            self._shallow_flag = True

        self._completed_attempt_event = AttemptResult(
            number=self._attempt_count,
            peak=round(self._peak, 6),
            qualified=qualified,
            classification=classification,
            reason=reason,
            duration_ms=None if duration is None else round(duration, 1),
        )

    def _recovery_is_compatible(self, progress: float) -> bool:
        if self._phase in (self._setup_phase, self._reset_phase):
            return True
        if self._phase == self._returning_phase:
            # Already past the turnaround: the recovered progress must not jump above the peak.
            return progress <= self._peak
        if self._phase in self._moving_phases:
            # Still outbound or at the peak: recovery must remain within the movement.
            return progress > self._top_return
        return False

    def _reset_attempt(self) -> None:
        self._peak = 0.0
        self._peak_at_ms = None
        self._setup_armed = False
        self._attempt_started_ms = None

    def _shift_phase_clocks(self, gap_ms: float) -> None:
        if self._phase_entered_ms is not None:
            self._phase_entered_ms += gap_ms
        if self._peak_at_ms is not None:
            self._peak_at_ms += gap_ms

    def _phase_is_stale(self, now_ms: float) -> bool:
        return bool(
            self._phase_entered_ms is not None
            and now_ms - self._phase_entered_ms > self._stale_phase_ms
        )

    def _state(self, observation: RepObservation | None, *, tracking: bool) -> RepState:
        completed = self._completed_attempt_event
        attempt_completed = "attempt_completed" in self._emitted_events
        return RepState(
            phase=self._phase,
            progress=None if observation is None else observation.progress,
            tracking=tracking,
            attempt_count=self._attempt_count,
            qualified_count=self._qualified_count,
            full_rom_count=self._full_rom_count,
            shallow_count=self._shallow_count,
            invalid_attempt_count=self._invalid_attempt_count,
            current_rep_peak=round(self._peak, 3),
            attempt_completed=attempt_completed,
            rep_completed=bool(attempt_completed and completed and completed.qualified),
            attempt_discarded="attempt_discarded" in self._emitted_events,
            rep_cycle_completed="rep_cycle_completed" in self._emitted_events,
            completed_attempt=completed,
            shallow_flag=self._shallow_flag,
            conditions=self._condition_snapshot(observation),
            fired_transitions=tuple(self._fired_transitions),
            shallow_not_counted=self._shallow_not_counted,
            too_fast_count=self._too_fast_count,
        )

    def _condition_snapshot(self, observation: RepObservation | None) -> dict[str, bool]:
        """The frame's movement facts, as the exercise reported them.

        Phase-dependent conditions (staleness, dwell, tracking recovery) are deliberately excluded:
        their truth depends on which phase the machine happens to be in, so recording them
        post-transition would describe the new phase and mislead the reader."""
        if observation is None:
            return {}
        return {
            "movement_started": observation.movement_started,
            "full_rom_reached": observation.full_rom_reached,
            "returned_to_rest": observation.returned_to_rest,
            "above_min_rep_peak": observation.progress >= self._min_rep_peak,
            "setup_armed": self._setup_armed,
        }

    def _build_transitions(self, transitions: object) -> dict[str, tuple[dict, ...]]:
        if not isinstance(transitions, list) or not transitions:
            raise ValueError("transitions must be a non-empty list")
        grouped: dict[str, list[dict]] = {phase: [] for phase in self._phases}
        identities: set[tuple[str, str]] = set()
        for item in transitions:
            if not isinstance(item, dict):
                raise ValueError("each FSM transition must be a mapping")
            source = item.get("from")
            destination = item.get("to")
            condition = item.get("when")
            action = item.get("action")
            event = item.get("emit")
            if source not in grouped or destination not in grouped:
                raise ValueError("FSM transition references an unknown phase")
            if condition not in _CONDITIONS:
                raise ValueError("FSM transition references an unknown condition")
            if action is not None and action not in _ACTIONS:
                raise ValueError("FSM transition references an unknown action")
            if event is not None and event not in _EVENTS:
                raise ValueError("FSM transition references an unknown event")
            identity = (source, condition)
            if identity in identities:
                raise ValueError("FSM transitions must have unique source/condition pairs")
            identities.add(identity)
            grouped[source].append(dict(item))
        if any(not values for values in grouped.values()):
            raise ValueError("every FSM phase requires an outgoing transition")
        return {phase: tuple(values) for phase, values in grouped.items()}

    def _derive_phase_roles(
        self,
        initial_phase: str,
    ) -> tuple[str, str, frozenset[str], str]:
        """Resolve lifecycle roles from the transition graph so no phase name is hard-coded.

        The resting phase is the initial phase. The single ``top_returned`` completion transition
        names both the returning movement phase (its source) and the reset phase (its target); every
        remaining phase is a movement phase. This lets a descend-first squat and an ascend-first
        curl reuse this machine with entirely different phase vocabularies.
        """
        completions = [
            (source, transition)
            for source, group in self._transitions.items()
            for transition in group
            if transition["when"] == "top_returned"
        ]
        if len(completions) != 1:
            raise ValueError("exactly one top_returned completion transition is required")
        returning_phase, completion = completions[0]
        reset_phase = completion["to"]
        moving_phases = frozenset(self._phases) - {initial_phase, reset_phase}
        if returning_phase not in moving_phases:
            raise ValueError("top_returned must originate from a movement phase")
        if reset_phase == initial_phase or not moving_phases:
            raise ValueError("top_returned must complete into a distinct reset phase")
        return initial_phase, reset_phase, moving_phases, returning_phase


def _finite(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise ValueError(f"{name} must be numeric")
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _positive(value: object, name: str) -> float:
    result = _finite(value, name)
    if result <= 0:
        raise ValueError(f"{name} must be positive")
    return result
