"""The side-on camera check — the rule that makes the push-up's camera requirement enforced."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.engine.loader import validate_exercise_config
from backend.tests.pushup_fixtures import FRONT_ON_LATERAL_PX, baseline, keypoints
from backend.workouts.pushup.rules.side_view_orientation import SideViewOrientationRule

_CONFIG = validate_exercise_config(
    "pushup", Path(__file__).resolve().parents[1] / "workouts" / "pushup"
)
_TEMPLATE = _CONFIG.templates["side_view_orientation"]


def rule(**overrides) -> SideViewOrientationRule:
    options = {
        "min_torso_length_px": _TEMPLATE["min_torso_length_px"],
        "confirm_frames": _TEMPLATE["confirm_frames"],
        "clear_frames": _TEMPLATE["clear_frames"],
        "hysteresis": True,
    }
    options.update(overrides)
    return SideViewOrientationRule(_TEMPLATE["policy"]["ranges"], **options)


def front_on(**options) -> dict:
    return keypoints(lateral=FRONT_ON_LATERAL_PX, far_v=0.9, **options)


class TestSignal:
    def test_a_side_on_frame_is_safe(self):
        reading = rule(hysteresis=False).read(keypoints(0.0))
        assert reading is not None
        assert reading.state == "safe"
        assert reading.not_ok is False
        # In profile the two shoulders project almost on top of each other.
        assert reading.spread_ratio < 0.1

    def test_a_front_on_frame_is_rejected(self):
        reading = rule(hysteresis=False).read(front_on())
        assert reading.state == "not_ok"
        assert reading.not_ok is True
        assert reading.spread_ratio > 0.42

    def test_the_worse_of_shoulders_and_hips_is_used(self):
        """Squaring up either the shoulders or the hips has to be caught."""
        frame = keypoints(0.0)
        for name in ("right_hip",):
            frame[name] = {**frame[name], "x": frame[name]["x"] + FRONT_ON_LATERAL_PX}
        reading = rule(hysteresis=False).read(frame)
        assert reading.hip_spread_ratio > reading.shoulder_spread_ratio
        assert reading.spread_ratio == pytest.approx(reading.hip_spread_ratio)
        assert reading.not_ok is True

    def test_the_ratio_is_distance_invariant(self):
        """Standing twice as far away must not change the verdict — the ratio normalizes it."""
        near = rule(hysteresis=False).read(keypoints(0.0))
        far = rule(hysteresis=False).read(_scaled(keypoints(0.0), 0.5))
        assert far is not None
        assert far.spread_ratio == pytest.approx(near.spread_ratio, abs=0.01)
        assert far.not_ok is near.not_ok

    def test_a_degenerate_torso_produces_no_reading(self):
        assert rule(min_torso_length_px=10_000.0).read(keypoints(0.0)) is None

    def test_low_confidence_produces_no_reading(self):
        assert rule().read(keypoints(0.0, v=0.2, far_v=0.2)) is None

    def test_a_persisted_baseline_can_be_classified(self):
        """The baseline stores geometry without visibility, so it needs its own read path."""
        assert rule(hysteresis=False).read_reference(baseline()).state == "safe"
        assert (
            rule(hysteresis=False)
            .read_reference(baseline(lateral=FRONT_ON_LATERAL_PX))
            .state
            == "not_ok"
        )


class TestHysteresis:
    def test_one_bad_frame_does_not_prompt_a_reposition(self):
        checker = rule()
        assert checker.read(keypoints(0.0)).not_ok is False
        assert checker.read(front_on()).not_ok is False

    def test_a_sustained_front_on_view_is_flagged(self):
        checker = rule()
        verdicts = [checker.read(front_on()).not_ok for _ in range(_TEMPLATE["confirm_frames"])]
        assert verdicts[-1] is True
        assert verdicts[0] is False

    def test_turning_back_clears_it(self):
        checker = rule()
        for _ in range(_TEMPLATE["confirm_frames"]):
            checker.read(front_on())
        cleared = [
            checker.read(keypoints(0.0)).not_ok for _ in range(_TEMPLATE["clear_frames"])
        ]
        assert cleared[-1] is False

    def test_the_raw_band_is_still_reported_while_debounced(self):
        """`state` is this frame; `not_ok` is the debounced verdict the UI acts on."""
        checker = rule()
        reading = checker.read(front_on())
        assert reading.state == "not_ok"
        assert reading.not_ok is False

    def test_reset_drops_the_history(self):
        checker = rule()
        for _ in range(_TEMPLATE["confirm_frames"]):
            checker.read(front_on())
        checker.reset()
        assert checker.read(front_on()).not_ok is False

    def test_setup_contexts_get_an_immediate_verdict(self):
        """The setup flow applies its own dwell; a gate that lags would bank dwell it should not."""
        assert rule(hysteresis=False).read(front_on()).not_ok is True

    def test_hysteresis_bounds_are_validated(self):
        with pytest.raises(ValueError, match="confirm_frames and clear_frames"):
            rule(confirm_frames=0)


def _scaled(frame: dict, factor: float) -> dict:
    centre_x = sum(point["x"] for point in frame.values()) / len(frame)
    centre_y = sum(point["y"] for point in frame.values()) / len(frame)
    return {
        name: {
            "x": centre_x + (point["x"] - centre_x) * factor,
            "y": centre_y + (point["y"] - centre_y) * factor,
            "v": point["v"],
        }
        for name, point in frame.items()
    }
