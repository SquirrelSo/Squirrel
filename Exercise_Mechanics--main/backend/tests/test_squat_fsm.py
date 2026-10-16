"""Stage 5 tests for squat attempts, qualified reps and tracking recovery."""

from __future__ import annotations

from copy import deepcopy

import pytest

from backend.engine.loader import fsm_params, load_exercise_config
from backend.workouts.squat.fsm import ASCENT, BOTTOM, DESCENT, RESET, SETUP, RepState, SquatFSM
from backend.workouts.squat.rules.depth import DepthRule

_GATE = 0.85
_FSM = fsm_params("squat")


def _fsm(**overrides) -> SquatFSM:
    return SquatFSM(reached_gate=lambda value: value >= _GATE, **{**_FSM, **overrides})


def _drive(fsm: SquatFSM, frames: list[tuple[float | None, float]]) -> RepState:
    state = None
    for progress, timestamp in frames:
        state = fsm.update(progress, timestamp)
    assert state is not None
    return state


_FULL_REP = [
    (0.00, 0),
    (0.30, 100),
    (0.60, 200),
    (0.90, 300),
    (0.95, 400),
    (0.90, 500),
    (0.70, 600),
    (0.30, 700),
    (0.05, 800),
]

_SHALLOW_REP = [
    (0.00, 0),
    (0.30, 100),
    (0.60, 200),
    (0.70, 300),
    (0.50, 400),
    (0.30, 500),
    (0.05, 600),
]

_INVALID_ATTEMPT = [
    (0.00, 0),
    (0.28, 100),
    (0.35, 200),
    (0.30, 300),
    (0.27, 400),
    (0.05, 500),
]


def _retime(frames: list[tuple[float | None, float]], start_ms: float):
    origin = frames[0][1]
    return [(progress, start_ms + timestamp - origin) for progress, timestamp in frames]


def _phase_order(fsm: SquatFSM, frames: list[tuple[float | None, float]]) -> list[str]:
    phases = [fsm.update(progress, timestamp).phase for progress, timestamp in frames]
    return [phase for index, phase in enumerate(phases) if index == 0 or phase != phases[index - 1]]


def test_full_rep_is_one_attempt_one_qualified_and_one_full_rom():
    state = _drive(_fsm(), _FULL_REP)

    assert state.attempt_count == 1
    assert state.qualified_count == 1
    assert state.rep_count == 1
    assert state.full_rom_count == 1
    assert state.shallow_count == 0
    assert state.invalid_attempt_count == 0
    assert state.attempt_completed is True
    assert state.rep_completed is True
    assert state.completed_attempt is not None
    assert state.completed_attempt.classification == "full_rom"
    assert state.completed_attempt.full_rom is True
    assert state.phase == RESET


def test_full_rep_visits_bottom_in_order():
    assert _phase_order(_fsm(), _FULL_REP) == [SETUP, DESCENT, BOTTOM, ASCENT, RESET]


def test_qualified_shallow_rep_counts_toward_set():
    state = _drive(_fsm(), _SHALLOW_REP)

    assert state.attempt_count == 1
    assert state.qualified_count == 1
    assert state.rep_count == 1
    assert state.full_rom_count == 0
    assert state.shallow_count == 1
    assert state.invalid_attempt_count == 0
    assert state.completed_attempt is not None
    assert state.completed_attempt.classification == "shallow"
    assert state.completed_attempt.shallow is True
    assert state.shallow_flag is True


def test_shallow_rep_never_visits_bottom():
    assert _phase_order(_fsm(), _SHALLOW_REP) == [SETUP, DESCENT, ASCENT, RESET]


def test_micro_movement_is_invalid_attempt_and_does_not_advance_set():
    state = _drive(_fsm(), _INVALID_ATTEMPT)

    assert state.attempt_count == 1
    assert state.qualified_count == 0
    assert state.rep_count == 0
    assert state.full_rom_count == 0
    assert state.shallow_count == 0
    assert state.invalid_attempt_count == 1
    assert state.attempt_completed is True
    assert state.rep_completed is False
    assert state.completed_attempt is not None
    assert state.completed_attempt.classification == "invalid"
    assert state.completed_attempt.qualified is False


def test_exact_min_rep_peak_is_qualified_and_shallow():
    state = _drive(
        _fsm(),
        [(0.0, 0), (0.30, 100), (0.40, 200), (0.35, 300), (0.30, 400), (0.05, 500)],
    )
    assert state.qualified_count == 1
    assert state.shallow_count == 1
    assert state.invalid_attempt_count == 0


def test_jitter_below_descent_trigger_is_not_an_attempt():
    state = _drive(_fsm(), [(value, index * 50) for index, value in enumerate((0.0, 0.08, 0.03, 0.09, 0.0))])
    assert state.phase == SETUP
    assert state.attempt_count == 0
    assert state.rep_count == 0


def test_invalid_shallow_and_full_sequence_preserves_counter_invariants():
    fsm = _fsm()
    _drive(fsm, _INVALID_ATTEMPT)
    for timestamp in (600, 700, 800, 900, 1000):
        fsm.update(0.0, timestamp)
    _drive(fsm, _retime(_SHALLOW_REP, 1100))
    for timestamp in (1800, 1900, 2000, 2100, 2200):
        fsm.update(0.0, timestamp)
    state = _drive(fsm, _retime(_FULL_REP, 2300))

    assert state.attempt_count == 3
    assert state.qualified_count == 2
    assert state.full_rom_count == 1
    assert state.shallow_count == 1
    assert state.invalid_attempt_count == 1
    assert state.attempt_count == state.qualified_count + state.invalid_attempt_count
    assert state.qualified_count == state.full_rom_count + state.shallow_count
    assert state.shallow_flag is False


def test_completion_edges_exist_on_only_the_return_frame():
    fsm = _fsm()
    states = [fsm.update(progress, timestamp) for progress, timestamp in _FULL_REP]
    assert sum(state.attempt_completed for state in states) == 1
    assert sum(state.rep_completed for state in states) == 1
    assert states[-1].attempt_completed is True


def test_reset_dwell_requires_a_fresh_standing_frame_to_rearm():
    fsm = _fsm()
    _drive(fsm, _FULL_REP)
    assert fsm.update(0.0, 850).phase == RESET
    assert fsm.update(0.0, 900).phase == SETUP
    assert fsm.update(0.4, 1000).phase == DESCENT


def test_tracking_loss_during_reset_restarts_dwell_before_cycle_completion():
    fsm = _fsm()
    _drive(fsm, _FULL_REP)

    assert fsm.update(None, 850).phase == RESET
    assert fsm.update(0.0, 900).rep_cycle_completed is False
    assert fsm.update(0.0, 950).rep_cycle_completed is False
    completed = fsm.update(0.0, 1000)

    assert completed.phase == SETUP
    assert completed.rep_cycle_completed is True


def test_turnaround_requires_configured_dwell_not_a_blip():
    state = _drive(
        _fsm(),
        [(0.0, 0), (0.3, 100), (0.6, 200), (0.7, 300), (0.6, 400), (0.72, 500)],
    )
    assert state.phase == DESCENT
    assert state.attempt_count == 0


def test_current_rep_peak_tracks_unrounded_maximum():
    state = _drive(_fsm(), [(0.0, 0), (0.3, 100), (0.9, 200), (0.6, 300)])
    assert state.current_rep_peak == pytest.approx(0.9)


def test_stale_bottom_discards_without_credit():
    fsm = _fsm(stale_phase_ms=500)
    states = [fsm.update(0.0, 0), fsm.update(0.9, 100)]
    states.extend(fsm.update(0.9, timestamp) for timestamp in range(200, 800, 100))
    state = states[-1]

    assert state.phase == SETUP
    assert state.attempt_discarded is True
    assert state.attempt_count == 0
    assert state.qualified_count == 0
    assert state.full_rom_count == 0


def test_stale_ascent_cannot_credit_a_rep_from_elapsed_time():
    fsm = _fsm(stale_phase_ms=500)
    _drive(fsm, [(0.0, 0), (0.4, 100), (0.9, 200), (0.8, 300), (0.7, 400)])
    assert fsm.update(0.6, 500).phase == ASCENT
    state = _drive(fsm, [(0.6, 600), (0.6, 700), (0.6, 800), (0.6, 900), (0.6, 1000)])
    assert state.phase == SETUP
    assert state.attempt_discarded is True
    assert state.attempt_count == 0
    assert state.rep_count == 0


def test_tracking_unavailable_pauses_turnaround_clock():
    fsm = _fsm()
    _drive(fsm, [(0.0, 0), (0.3, 30), (0.7, 60)])
    paused = fsm.update(None, 90)
    recovered = fsm.update(0.6, 140)
    before_dwell = fsm.update(0.5, 240)
    after_dwell = fsm.update(0.4, 340)

    assert paused.tracking is False
    assert paused.phase == DESCENT
    assert recovered.phase == DESCENT
    assert before_dwell.phase == DESCENT
    assert after_dwell.phase == ASCENT


def test_short_compatible_gap_can_resume_and_complete():
    fsm = _fsm()
    _drive(fsm, [(0.0, 0), (0.3, 30), (0.6, 60), (0.7, 90)])
    fsm.update(None, 120)
    assert fsm.update(0.6, 180).phase == DESCENT
    assert fsm.update(0.5, 280).phase == DESCENT
    assert fsm.update(0.4, 380).phase == ASCENT
    state = fsm.update(0.05, 410)
    assert state.qualified_count == 1
    assert state.shallow_count == 1


def test_short_incompatible_gap_discards_partial_attempt():
    fsm = _fsm()
    _drive(fsm, [(0.0, 0), (0.3, 30), (0.5, 60)])
    fsm.update(None, 90)
    state = fsm.update(0.05, 140)

    assert state.phase == SETUP
    assert state.attempt_discarded is True
    assert state.attempt_count == 0
    assert state.rep_count == 0


def test_long_gap_discards_even_a_full_depth_partial_attempt():
    fsm = _fsm()
    _drive(fsm, [(0.0, 0), (0.4, 30), (0.9, 60)])
    state = fsm.update(0.7, 1100)   # over the configured max_tracking_gap_ms

    assert state.phase == SETUP
    assert state.attempt_discarded is True
    assert state.attempt_count == 0
    assert state.full_rom_count == 0


def test_short_gap_during_ascent_can_complete_on_valid_return_frame():
    fsm = _fsm()
    _drive(fsm, _FULL_REP[:-2])
    assert fsm.update(0.3, 700).phase == ASCENT
    fsm.update(None, 730)
    state = fsm.update(0.05, 780)

    assert state.rep_completed is True
    assert state.full_rom_count == 1


def test_constructor_and_inputs_fail_loud_for_invalid_values():
    with pytest.raises(ValueError, match="progress thresholds"):
        _fsm(min_rep_peak=0.05)
    with pytest.raises(ValueError, match="max_frame_delta_ms"):
        _fsm(max_frame_delta_ms=0)

    fsm = _fsm()
    fsm.update(0.0, 100)
    with pytest.raises(ValueError, match="monotonic"):
        fsm.update(0.0, 99)
    with pytest.raises(ValueError, match="progress must be finite"):
        fsm.update(float("nan"), 101)


def test_real_config_drives_min_peak_gap_boundary_and_single_depth_gate():
    config = load_exercise_config("squat")
    depth_template = config.templates["depth"]
    depth = DepthRule(
        baseline_hip_y=100,
        baseline_knee_y=200,
        full_rom_gate=depth_template["full_rom_gate"],
        min_baseline_span_px=depth_template["min_baseline_span_px"],
    )
    fsm = SquatFSM(reached_gate=depth.is_full_depth, **fsm_params("squat"))

    assert depth.full_rom_gate == pytest.approx(0.85)
    state = _drive(
        fsm,
        [(0.0, 0), (0.3, 100), (0.85, 200), (0.8, 300), (0.7, 400), (0.05, 500)],
    )
    assert state.completed_attempt is not None
    assert state.completed_attempt.classification == "full_rom"
    assert state.full_rom_count == 1


def test_phase_destination_is_executed_from_configured_transition_table():
    transitions = deepcopy(_FSM["transitions"])
    route = next(
        transition
        for transition in transitions
        if transition["from"] == BOTTOM
        and transition["when"] == "turnaround_confirmed"
    )
    route["to"] = RESET
    fsm = _fsm(transitions=transitions)

    state = _drive(
        fsm,
        [(0.0, 0), (0.3, 100), (0.9, 200), (0.8, 300), (0.7, 400)],
    )

    assert state.phase == RESET


# ------------------------------------------------------- capture instrumentation (diagnostics)

def test_conditions_expose_what_each_frame_said_without_changing_behaviour():
    """The dwell question — 'was that transition a real movement or one noisy frame?' — can only be
    answered later if each frame's predicates were recorded at the time."""
    fsm = _fsm()
    resting = fsm.update(0.0, 0)
    assert resting.conditions["movement_started"] is False
    assert resting.conditions["setup_armed"] is True

    deep = fsm.update(0.95, 200)
    assert deep.conditions["movement_started"] is True
    assert deep.conditions["full_rom_reached"] is True
    assert deep.conditions["above_min_rep_peak"] is True
    assert deep.conditions["returned_to_rest"] is False


def test_untracked_frames_report_no_conditions():
    """With no progress value there are no predicates to record — an empty map, not stale ones."""
    fsm = _fsm()
    fsm.update(0.5, 0)
    assert fsm.update(None, 100).conditions == {}


def test_fired_transitions_record_every_transition_in_order():
    fsm = _fsm()
    fsm.update(0.0, 0)
    assert fsm.update(0.5, 100).fired_transitions == ({"from": "setup", "to": "descent", "when": "descent_started"},)
    # A frame that both reaches the gate and is already turning can run two transitions.
    entering_bottom = fsm.update(0.95, 200)
    assert [t["when"] for t in entering_bottom.fired_transitions] == ["full_rom_reached"]
    assert entering_bottom.phase == "bottom"


def test_diagnostics_snapshot_carries_exercise_specific_extras():
    from backend.engine.rep_fsm import fsm_diagnostics

    fsm = _fsm()
    state = fsm.update(0.4, 0)
    snapshot = fsm_diagnostics(state, arm_peaks={"left": 0.9, "right": 0.4})

    assert snapshot["phase"] == state.phase
    assert snapshot["progress"] == 0.4
    assert snapshot["conditions"] == state.conditions
    assert snapshot["arm_peaks"] == {"left": 0.9, "right": 0.4}
