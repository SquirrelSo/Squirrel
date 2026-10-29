"""Only controlled reps count, and shallow ones are warned about (fsm.yaml count_shallow / min_rep_ms).

Field test: 36 squats in 38 s of active time, every one shallow, all counted and paid for. Here the
real squat configuration decides: a rep quicker than the minimum rep time is an invalid attempt with
its reason, coached at once, and never advances the set. A rep short of full depth counts, with a
warning said at once, and is no good rep (no XP).
"""

from __future__ import annotations

from math import pi, sin

import pytest

from backend.engine.loader import load_exercise_config
from backend.engine.rep_fsm import RepFSM
from backend.workouts.squat.adapter import build_squat_adapter

from backend.tests.test_squat_adapter import _baseline, _frame


def _rep(peak: float, duration_ms: int, start_ms: int, *, rest_ms: int = 600) -> list[tuple[float, int]]:
    """One squat: standing → `peak` depth → standing over `duration_ms`, sampled every 50 ms, then
    `rest_ms` standing still."""
    frames = [(peak * sin(pi * t / duration_ms), start_ms + t) for t in range(0, duration_ms, 50)]
    frames.append((0.0, start_ms + duration_ms))
    frames += [(0.0, start_ms + duration_ms + t) for t in range(50, rest_ms + 1, 50)]
    return frames


def _drive(adapter, frames):
    statuses = [adapter.process(_frame(progress, t)) for progress, t in frames]
    return statuses


@pytest.mark.parametrize("exercise", ["squat", "pushup", "bicep_curl"])
def test_rep_exercises_count_controlled_reps_and_warn_on_shallow_ones(exercise):
    fsm = load_exercise_config(exercise).fsm
    assert fsm["count_shallow"] is True
    assert fsm["min_rep_ms"] >= 1000
    assert fsm["too_fast_cue"]


def test_a_controlled_full_squat_counts():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    status = _drive(adapter, _rep(0.95, 2400, 0))[-1]
    assert status["counters"]["qualified"] == 1
    assert status["last_attempt"]["classification"] == "full_rom"
    assert status["last_attempt"]["reason"] is None
    assert status["set"]["completed_reps"] == 1


def test_a_bounced_squat_is_not_counted_and_says_slow_down():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    statuses = _drive(adapter, _rep(0.95, 900, 0))
    status = statuses[-1]
    assert status["counters"]["qualified"] == 0
    assert status["counters"]["invalid"] == 1
    assert status["counters"]["not_counted"] == {"shallow": 0, "too_fast": 1}
    assert status["last_attempt"]["reason"] == "too_fast"
    assert status["set"]["completed_reps"] == 0
    cues = [s["cue"] for s in statuses if s["cue"]]
    assert any(c["rule_id"] == "tempo" and "too fast" in c["text"] for c in cues)


def test_a_shallow_squat_counts_with_a_warning_at_once():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    statuses = _drive(adapter, _rep(0.6, 2400, 0))
    status = statuses[-1]
    assert status["counters"]["qualified"] == 1
    assert status["counters"]["shallow"] == 1
    assert status["counters"]["full_rom"] == 0
    assert status["counters"]["not_counted"] == {"shallow": 0, "too_fast": 0}
    assert status["last_attempt"]["classification"] == "shallow"
    assert status["last_attempt"]["reason"] is None
    assert status["set"]["completed_reps"] == 1
    completed = next(i for i, s in enumerate(statuses) if s["counters"]["attempts"] == 1)
    assert statuses[completed]["cue"]["text"].startswith("Shallow rep:")


def test_the_set_finishes_on_counted_reps_and_never_on_too_fast_ones():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    frames, t = [], 0
    for peak, duration in [(0.6, 2400), (0.95, 900), (0.95, 2400), (0.6, 2400), (0.95, 2400)]:
        frames += _rep(peak, duration, t)
        t = frames[-1][1] + 50
    statuses = _drive(adapter, frames)
    final = statuses[-1]
    assert final["counters"]["attempts"] == 5
    assert final["set"]["completed_reps"] == 4
    assert final["counters"]["full_rom"] == 2
    assert final["counters"]["shallow"] == 2
    assert final["set"]["complete"] is True
    assert final["counters"]["not_counted"] == {"shallow": 0, "too_fast": 1}
    # the too-fast second rep did not count: the third counted rep was the fourth attempt
    first_complete = next(i for i, s in enumerate(statuses) if s["set"]["complete"])
    assert statuses[first_complete]["counters"]["attempts"] == 4


def _machine(**policy) -> RepFSM:
    return RepFSM(
        lambda peak: peak >= 0.9,
        phases=["setup", "down", "up", "reset"],
        initial_phase="setup",
        transitions=[
            {"from": "setup", "to": "down", "when": "descent_started"},
            {"from": "down", "to": "up", "when": "turnaround_confirmed"},
            {"from": "down", "to": "setup", "when": "phase_stale", "action": "discard_attempt", "emit": "attempt_discarded"},
            {"from": "up", "to": "reset", "when": "top_returned", "action": "complete_attempt", "emit": "attempt_completed"},
            {"from": "up", "to": "setup", "when": "phase_stale", "action": "discard_attempt", "emit": "attempt_discarded"},
            {"from": "reset", "to": "setup", "when": "reset_dwell_elapsed", "action": "reset_attempt", "emit": "rep_cycle_completed"},
        ],
        descent_trigger=0.25, top_return=0.25, min_rep_peak=0.4, turnaround_ms=100,
        reset_dwell_ms=100, stale_phase_ms=10000, max_frame_delta_ms=100, **policy,
    )


def _run(fsm: RepFSM, peak: float, duration_ms: int):
    state = None
    for progress, t in _rep(peak, duration_ms, 0):
        state = fsm.update(progress, t)
        if state.completed_attempt is not None:
            return state.completed_attempt
    raise AssertionError("no attempt completed")


def test_without_a_policy_every_rep_past_min_peak_counts():
    assert _run(_machine(), 0.6, 500).classification == "shallow"
    assert _run(_machine(), 0.95, 500).qualified


def test_the_rep_time_is_measured_from_leaving_rest_to_returning():
    attempt = _run(_machine(min_rep_ms=1000), 0.95, 2000)
    assert attempt.qualified
    # sin rises past 0.25/0.95 at ~8.5 % of the rep and falls under it at ~91.5 %
    assert 1500 < attempt.duration_ms < 1800
    fast = _run(_machine(min_rep_ms=1000), 0.95, 1000)
    assert (fast.qualified, fast.reason) == (False, "too_fast")


def test_too_fast_is_reported_before_shallow_and_below_min_peak_before_both():
    assert _run(_machine(min_rep_ms=1000, count_shallow=False), 0.6, 600).reason == "too_fast"
    assert _run(_machine(min_rep_ms=1000, count_shallow=False), 0.3, 600).reason == "below_min_peak"
    assert _run(_machine(count_shallow=False), 0.6, 2000).reason == "shallow"
