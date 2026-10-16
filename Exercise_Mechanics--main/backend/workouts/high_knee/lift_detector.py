"""Exercise-local lift vocabulary over the shared repetition state machine.

High Knees needs one independent machine per leg, but it does not need a second generic FSM. This
wrapper maps configured lift thresholds onto ``RepFSM`` and translates completed/discarded attempts
into timed lift cycles. Internal setup/reset phases are both published as the canonical ``down``
phase; the underlying phase remains available in capture diagnostics.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Callable, Literal, Mapping

from backend.engine.rep_fsm import RepFSM, RepState, fsm_diagnostics
from backend.training.timed_contract import LiftClassification, LiftSide

LiftPhase = Literal["down", "ascent", "top", "descent"]


@dataclass(frozen=True)
class DetectedLiftCycle:
    """A finalized side-local cycle before the adapter assigns a global lift id."""

    side: LiftSide
    classification: LiftClassification
    peak_progress: float
    started_t_ms: float
    completed_t_ms: float
    tracking_invalid: bool
    # Why an invalid lift did not count: "too_slow" (slower than max_lift_ms), else None.
    reason: str | None = None


@dataclass(frozen=True)
class HighKneeLiftState:
    side: LiftSide
    phase: LiftPhase
    internal_phase: str
    tracking: bool
    current_peak: float
    full_rom_crossed: bool
    latched: bool
    cycle: DetectedLiftCycle | None
    diagnostics: dict


class HighKneeLiftDetector:
    """One leg's lift detector backed by the shared configured ``RepFSM``."""

    def __init__(
        self,
        side: LiftSide,
        *,
        reached_gate: Callable[[float], bool],
        phases: list[str],
        initial_phase: str,
        transitions: list[dict],
        movement_start: float,
        reset: float,
        min_lift_peak: float,
        turnaround_ms: float,
        reset_dwell_ms: float,
        stale_phase_ms: float,
        max_frame_delta_ms: float,
        max_tracking_gap_ms: float | None = None,
        max_lift_ms: float | None = None,
        frame_cadence: Mapping | None = None,
    ) -> None:
        if side not in {"left", "right"}:
            raise ValueError("lift detector side must be 'left' or 'right'")
        self._side = side
        self._fsm = RepFSM(
            reached_gate=reached_gate,
            phases=phases,
            initial_phase=initial_phase,
            transitions=transitions,
            descent_trigger=movement_start,
            top_return=reset,
            min_rep_peak=min_lift_peak,
            turnaround_ms=turnaround_ms,
            reset_dwell_ms=reset_dwell_ms,
            stale_phase_ms=stale_phase_ms,
            max_frame_delta_ms=max_frame_delta_ms,
            max_tracking_gap_ms=max_tracking_gap_ms,
            frame_cadence=frame_cadence,
        )
        self._reached_gate = reached_gate
        # A high knee is a running movement: a lift slower than this (leaving the standing band to
        # returning to it) is a march, and does not count.
        self._max_lift_ms = max_lift_ms
        self._attempt_started_t_ms: float | None = None
        self._attempt_peak = 0.0
        self._full_rom_crossed = False

    def update(self, progress: float | None, now_ms: float) -> HighKneeLiftState:
        if progress is not None and not isfinite(progress):
            progress = None
        state = self._fsm.update(progress, now_ms)
        started_now = any(
            transition["when"] == "descent_started"
            for transition in state.fired_transitions
        )
        if started_now:
            self._attempt_started_t_ms = float(now_ms)
            self._attempt_peak = max(0.0, float(progress or 0.0))
            self._full_rom_crossed = bool(
                progress is not None and self._reached_gate(progress)
            )
        elif self._attempt_started_t_ms is not None and not state.attempt_discarded:
            if progress is not None:
                self._attempt_peak = max(self._attempt_peak, progress)
                self._full_rom_crossed = (
                    self._full_rom_crossed or self._reached_gate(progress)
                )

        cycle = self._cycle(state, now_ms)
        diagnostic_started_t_ms = (
            cycle.started_t_ms if cycle is not None else self._attempt_started_t_ms
        )
        diagnostic_full_rom = (
            cycle.classification == "full_rom"
            if cycle is not None
            else self._full_rom_crossed
        )
        if cycle is not None:
            self._attempt_started_t_ms = None
            self._attempt_peak = 0.0
            self._full_rom_crossed = False

        return HighKneeLiftState(
            side=self._side,
            phase=_public_phase(state.phase),
            internal_phase=state.phase,
            tracking=state.tracking,
            current_peak=(
                cycle.peak_progress
                if cycle is not None
                else round(self._attempt_peak, 6)
            ),
            full_rom_crossed=diagnostic_full_rom,
            latched=state.phase != "setup",
            cycle=cycle,
            diagnostics=fsm_diagnostics(
                state,
                side=self._side,
                public_phase=_public_phase(state.phase),
                attempt_started_t_ms=diagnostic_started_t_ms,
                full_rom_crossed=diagnostic_full_rom,
            ),
        )

    def _cycle(self, state: RepState, now_ms: float) -> DetectedLiftCycle | None:
        started = self._attempt_started_t_ms
        if started is None:
            return None
        if state.completed_attempt is not None:
            classification = state.completed_attempt.classification
            too_slow = (
                self._max_lift_ms is not None
                and classification != "invalid"
                and now_ms - started > self._max_lift_ms
            )
            return DetectedLiftCycle(
                self._side,
                "invalid" if too_slow else classification,
                state.completed_attempt.peak,
                started,
                float(now_ms),
                False,
                "too_slow" if too_slow else None,
            )
        if state.attempt_discarded:
            return DetectedLiftCycle(
                self._side,
                "invalid",
                round(max(0.0, self._attempt_peak), 6),
                started,
                float(now_ms),
                True,
            )
        return None


def _public_phase(internal_phase: str) -> LiftPhase:
    if internal_phase in {"setup", "reset"}:
        return "down"
    if internal_phase in {"ascent", "top", "descent"}:
        return internal_phase
    raise RuntimeError(f"unsupported High Knee lift phase: {internal_phase}")


def high_knee_lift_detector(
    side: LiftSide,
    *,
    reached_gate: Callable[[float], bool],
    fsm: dict,
    max_frame_delta_ms: float,
    frame_cadence: Mapping | None = None,
) -> HighKneeLiftDetector:
    """Build one detector from the strict timed FSM document without adding defaults."""
    return HighKneeLiftDetector(
        side,
        reached_gate=reached_gate,
        phases=fsm["phases"],
        initial_phase=fsm["initial_phase"],
        transitions=fsm["transitions"],
        movement_start=fsm["movement_start"],
        reset=fsm["reset"],
        min_lift_peak=fsm["min_lift_peak"],
        turnaround_ms=fsm["turnaround_ms"],
        reset_dwell_ms=fsm["reset_dwell_ms"],
        stale_phase_ms=fsm["stale_phase_ms"],
        max_frame_delta_ms=max_frame_delta_ms,
        max_tracking_gap_ms=fsm.get("max_tracking_gap_ms"),
        max_lift_ms=fsm.get("max_lift_ms"),
        frame_cadence=frame_cadence,
    )
