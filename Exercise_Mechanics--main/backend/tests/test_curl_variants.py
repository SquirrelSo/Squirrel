"""Field test: a single-arm curl plan counted double-arm reps with no word about it. The session's
variant now reaches the adapter: a double-arm set needs both arms through every rep; a single-arm set
counts the working arm and says so when both arms curl together. Real config, realistic tempo."""

from __future__ import annotations

from math import pi, sin

from backend.training.builders import build_training_adapter
from backend.training.target_contract import RepTarget
from backend.workouts.bicep_curl.adapter import build_bicep_curl_adapter

from backend.tests.test_bicep_curl_adapter import _BASELINE, _frame


def _curls(adapter, arms: list[tuple[float, float]], seconds: float = 2.0, t: int = 0):
    """Curl reps, each `seconds` long from time `t`; `arms` gives each rep's (left, right) peak."""
    statuses = []
    for left_peak, right_peak in arms:
        for step in range(0, int(seconds * 1000), 50):
            s = sin(pi * step / (seconds * 1000))
            statuses.append(adapter.process(_frame(left_peak * s, t, right_peak * s)))
            t += 50
        for _ in range(10):
            statuses.append(adapter.process(_frame(0.0, t, 0.0)))
            t += 50
    return statuses


def _cues(statuses) -> set[str]:
    return {s["cue"]["text"] for s in statuses if s["cue"]}


def test_double_arm_plan_counts_only_reps_where_both_arms_curl():
    adapter = build_bicep_curl_adapter(baseline=_BASELINE, target_reps=5, variant="double")
    statuses = _curls(adapter, [(0.95, 0.95), (0.95, 0.0), (0.95, 0.95), (0.0, 0.95)])
    assert statuses[-1]["set"]["completed_reps"] == 2
    assert "Curl with both arms together." in _cues(statuses)


def test_double_arm_plan_with_one_arm_short_is_a_shallow_rep():
    adapter = build_bicep_curl_adapter(baseline=_BASELINE, target_reps=5, variant="double")
    statuses = _curls(adapter, [(0.95, 0.55)])
    assert statuses[-1]["set"]["completed_reps"] == 1
    assert statuses[-1]["counters"]["shallow"] == 1
    assert statuses[-1]["counters"]["full_rom"] == 0
    # The arm-specific cue says more than the generic shallow warning, so it wins.
    assert "Curl with both arms together." in _cues(statuses)


def test_single_arm_plan_counts_each_arm_and_says_so_when_both_curl():
    adapter = build_bicep_curl_adapter(baseline=_BASELINE, target_reps=5, variant="single")
    statuses = _curls(adapter, [(0.95, 0.0), (0.0, 0.95)])
    assert statuses[-1]["set"]["completed_reps"] == 2
    assert "Single-arm curl: curl one arm at a time." not in _cues(statuses)
    statuses = _curls(adapter, [(0.95, 0.95)], t=10_000)
    assert "Single-arm curl: curl one arm at a time." in _cues(statuses)


def test_the_session_variant_reaches_the_curl_adapter_only():
    curl = build_training_adapter("bicep_curl", baseline=_BASELINE, target=RepTarget("reps", 5), variant="double")
    assert curl._variant == "double"
    # Exercises without variants ignore it rather than failing.
    from backend.tests.test_squat_adapter import _baseline
    build_training_adapter("squat", baseline=_baseline(), target=RepTarget("reps", 5), variant="double")
