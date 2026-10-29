"""Tests for the depth rule (backend/workouts/squat/rules/depth.py) — the squat ROM brain.

Synthetic hip/knee landmarks at chosen y positions drive the depth signal to known values,
so every biomechanical claim is checked in isolation (no FSM, no rep counting):
the ratio math, the full-depth gate, the ATG indicator, the shallow-vs-full verdict a rep
machine will use, scale/distance invariance, and the construction + keypoint guards.

Reference used throughout: standing hip y=200, knee y=340 → ROM=140. The single configured
full-ROM gate is 0.85; depth has no hysteresis.

Runs under pytest OR as a plain script (PYTHONPATH=. python3 backend/tests/test_depth_rule.py).
"""

from __future__ import annotations

import pytest

from backend.workouts.squat.rules.depth import DepthRule, DepthReading

_BASE_HIP_Y = 200.0
_BASE_KNEE_Y = 340.0     # ROM = 140 px
_FULL_ROM_GATE = 0.85


def _kps(hip_y: float, knee_y: float = 500.0, v: float = 0.9) -> dict:
    """A frame with left/right hip at hip_y and left/right knee at knee_y (so the midpoints are
    exactly those). knee_y defaults well below the hip so hip_below_knee is False unless set."""
    return {
        "left_hip":   {"x": 300.0, "y": hip_y,  "z": 0.0, "v": v},
        "right_hip":  {"x": 340.0, "y": hip_y,  "z": 0.0, "v": v},
        "left_knee":  {"x": 305.0, "y": knee_y, "z": 0.0, "v": v},
        "right_knee": {"x": 335.0, "y": knee_y, "z": 0.0, "v": v},
    }


_MIN_SPAN = 60.0         # config min_baseline_span_px (no code default)


def _rule(gate: float = _FULL_ROM_GATE) -> DepthRule:
    return DepthRule(_BASE_HIP_Y, _BASE_KNEE_Y, gate, min_baseline_span_px=_MIN_SPAN)


# ── the depth measurement ────────────────────────────────────────────────────────

def test_standing_is_zero_depth():
    r = _rule().read(_kps(hip_y=200.0))
    assert r is not None
    assert r.depth_ratio == pytest.approx(0.0)


def test_hip_at_standing_knee_height_is_depth_one():
    # hip descended to y=340 (the standing knee height) → exactly 1.0
    assert _rule().read(_kps(hip_y=340.0)).depth_ratio == pytest.approx(1.0)


def test_partial_descent_is_proportional():
    # hip at 200 + 0.5*140 = 270 → depth 0.5
    assert _rule().read(_kps(hip_y=270.0)).depth_ratio == pytest.approx(0.5)


def test_below_parallel_exceeds_one():
    # hip at 380 → (380-200)/140 = 1.2857…
    assert _rule().read(_kps(hip_y=380.0)).depth_ratio == pytest.approx(180.0 / 140.0)


def test_hip_above_standing_is_negative_not_clamped():
    # rising onto toes lifts the hip above baseline → slightly negative, kept raw
    assert _rule().read(_kps(hip_y=186.0)).depth_ratio == pytest.approx(-0.1)


def test_ratio_is_scale_and_distance_invariant():
    # Same pose captured twice as big (further-to-nearer camera): a pure ratio is unchanged.
    near = DepthRule(200.0, 340.0, _FULL_ROM_GATE, min_baseline_span_px=_MIN_SPAN).read(_kps(hip_y=319.0)).depth_ratio
    far  = DepthRule(400.0, 680.0, _FULL_ROM_GATE, min_baseline_span_px=_MIN_SPAN).read(_kps(hip_y=638.0)).depth_ratio  # ×2
    assert near == pytest.approx(0.85)
    assert far == pytest.approx(near)


def test_midpoint_uses_both_sides():
    # left hip 260, right hip 280 → mid 270 → depth 0.5
    kps = _kps(hip_y=0.0)
    kps["left_hip"]["y"], kps["right_hip"]["y"] = 260.0, 280.0
    assert _rule().read(kps).depth_ratio == pytest.approx(0.5)


# ── the full-depth gate (the shallow/full brain) ──────────────────────────────────

def test_exactly_at_full_rom_gate_is_full():
    r = _rule().read(_kps(hip_y=200.0 + 0.85 * 140.0))    # hip 319 → depth 0.85
    assert r.depth_ratio == pytest.approx(0.85)
    assert r.full_depth is True


def test_above_gate_is_full():
    r = _rule().read(_kps(hip_y=200.0 + 0.87 * 140.0))
    assert r.full_depth is True


def test_is_full_depth_gate_predicate():
    rule = _rule()
    assert rule.full_rom_gate == pytest.approx(0.85)
    assert rule.is_full_depth(0.90) is True      # a deep rep's peak → full
    assert rule.is_full_depth(0.85) is True      # exactly at the gate
    assert rule.is_full_depth(0.80) is False     # a shallow rep's peak → SHALLOW


def test_shallow_vs_full_rep_verdict_from_peak():
    # This is how the rep machine will flag shallow reps: apply the gate to the rep's PEAK.
    rule = _rule()
    full_rep_peak, shallow_rep_peak = 0.95, 0.72
    assert rule.is_full_depth(full_rep_peak) is True
    assert rule.is_full_depth(shallow_rep_peak) is False


# ── shortfall + ATG indicator ─────────────────────────────────────────────────────

def test_shortfall_below_target():
    r = _rule().read(_kps(hip_y=270.0))          # depth 0.5, target 0.85
    assert r.shortfall == pytest.approx(0.35)


def test_shortfall_none_when_at_or_over_target():
    assert _rule().read(_kps(hip_y=340.0)).shortfall is None   # depth 1.0 ≥ target


def test_hip_below_knee_atg_indicator():
    # hip (380) below the live knee (360) → ATG True
    assert _rule().read(_kps(hip_y=380.0, knee_y=360.0)).hip_below_knee is True
    # hip (300) above the live knee (360) → False
    assert _rule().read(_kps(hip_y=300.0, knee_y=360.0)).hip_below_knee is False


# ── keypoint gating (no reading on partial/low-confidence data) ────────────────────

def test_missing_hip_returns_none():
    kps = _kps(hip_y=270.0)
    del kps["left_hip"]
    assert _rule().read(kps) is None


def test_hidden_knees_still_read_depth_from_the_hips():
    # Close to the camera the knees reach the bottom edge of the image as the person squats.
    kps = _kps(hip_y=270.0)
    del kps["left_knee"]
    kps["right_knee"]["v"] = 0.2
    reading = _rule().read(kps)
    assert reading.depth_ratio == pytest.approx(0.5)
    assert reading.hip_below_knee is None


def test_low_confidence_landmark_returns_none():
    kps = _kps(hip_y=270.0)
    kps["right_hip"]["v"] = 0.3                    # below CONFIDENCE_MIN (0.5)
    assert _rule().read(kps) is None


def test_non_numeric_landmark_returns_none():
    kps = _kps(hip_y=270.0)
    kps["left_hip"]["y"] = None
    assert _rule().read(kps) is None


# ── construction guards ───────────────────────────────────────────────────────────

def test_knee_not_below_hip_rejected():
    with pytest.raises(ValueError):
        DepthRule(340.0, 200.0, _FULL_ROM_GATE, min_baseline_span_px=_MIN_SPAN)


def test_implausibly_small_rom_rejected():
    with pytest.raises(ValueError):
        DepthRule(200.0, 240.0, _FULL_ROM_GATE, min_baseline_span_px=_MIN_SPAN)  # ROM 40 < 60


def test_non_positive_gate_rejected():
    with pytest.raises(ValueError):
        DepthRule(_BASE_HIP_Y, _BASE_KNEE_Y, 0.0, min_baseline_span_px=_MIN_SPAN)


def test_reading_is_immutable():
    r = _rule().read(_kps(hip_y=270.0))
    assert isinstance(r, DepthReading)
    with pytest.raises(Exception):
        r.depth_ratio = 0.0   # frozen dataclass


if __name__ == "__main__":
    import sys, traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for fn in fns:
        try:
            fn(); passed += 1; print(f"  ok   {fn.__name__}")
        except Exception:
            print(f"  FAIL {fn.__name__}"); traceback.print_exc()
    print(f"\n{passed}/{len(fns)} depth-rule tests passed")
    sys.exit(0 if passed == len(fns) else 1)
