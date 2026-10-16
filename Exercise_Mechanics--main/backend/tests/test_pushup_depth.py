"""Push-up depth kernel: the ROM signal and the full/shallow gate."""

from __future__ import annotations

import pytest

from backend.tests.pushup_fixtures import (
    BASELINE_ELBOW_DEG,
    TARGET_ELBOW_DEG,
    baseline,
    elbow_angle_for,
    keypoints,
)
from backend.workouts.pushup.rules.pushup_depth import PushUpDepthRule

GATE = 0.90


def rule(**overrides) -> PushUpDepthRule:
    options = {
        "target_elbow_angle_deg": TARGET_ELBOW_DEG,
        "full_rom_gate": GATE,
        "min_baseline_elbow_angle_deg": 140.0,
        "min_upper_arm_px": 40.0,
    }
    options.update(overrides)
    return PushUpDepthRule(baseline(), **options)


class TestSignal:
    def test_the_captured_top_reads_zero(self):
        """Progress is measured from THIS person's extended arm, not from an assumed 180 deg."""
        reading = rule().read(keypoints(0.0))
        assert reading is not None
        assert reading.progress == pytest.approx(0.0, abs=0.01)

    def test_the_target_elbow_angle_reads_one(self):
        reading = rule().read(keypoints(1.0))
        assert reading.progress == pytest.approx(1.0, abs=0.01)
        assert reading.elbow_angle_deg == pytest.approx(TARGET_ELBOW_DEG, abs=0.5)

    def test_progress_tracks_elbow_flexion(self):
        readings = [rule().read(keypoints(p)).progress for p in (0.0, 0.25, 0.5, 0.75, 1.0)]
        assert all(b > a for a, b in zip(readings, readings[1:]))

    def test_deeper_than_the_target_is_not_clamped(self):
        """The FSM compares raw peaks, so clamping here would hide a genuinely deep rep."""
        reading = rule().read(keypoints(1.3))
        assert reading.progress > 1.0

    def test_the_raw_elbow_angle_is_reported_for_tuning(self):
        reading = rule().read(keypoints(0.6))
        assert reading.elbow_angle_deg == pytest.approx(elbow_angle_for(0.6), abs=0.5)


class TestGate:
    def test_reaching_the_gate_is_a_full_rep(self):
        assert rule().is_full_depth(GATE) is True
        assert rule().is_full_depth(GATE + 0.05) is True

    def test_short_of_the_gate_is_not(self):
        assert rule().is_full_depth(GATE - 0.01) is False

    def test_the_frame_flag_and_the_gate_cannot_disagree(self):
        depth = rule()
        for progress in (0.2, 0.8, 0.9, 1.1):
            reading = depth.read(keypoints(progress))
            assert reading.full_depth == depth.is_full_depth(reading.progress)

    def test_shortfall_is_reported_only_when_short(self):
        assert rule().read(keypoints(0.5)).shortfall == pytest.approx(0.4, abs=0.02)
        assert rule().read(keypoints(1.0)).shortfall is None


class TestSideSelection:
    def test_the_camera_facing_arm_is_measured(self):
        """In profile the far arm is occluded; the rule reads the one that is tracked."""
        reading = rule().read(keypoints(0.5, v=0.9, far_v=0.4))
        assert reading.side == "left"

    def test_it_switches_when_the_user_faces_the_other_way(self):
        frame = keypoints(0.5, v=0.4, far_v=0.95)
        assert rule().read(frame).side == "right"

    def test_both_arms_measure_nearly_the_same_angle(self):
        """Which side is chosen must not materially change the reading in a profile view."""
        left = rule().read(keypoints(0.6, v=0.9, far_v=0.4))
        right = rule().read(keypoints(0.6, v=0.4, far_v=0.9))
        assert left.progress == pytest.approx(right.progress, abs=0.02)


class TestUnavailableFrames:
    def test_low_confidence_produces_no_reading(self):
        """Never advance a rep on jitter: a low-confidence joint is 'no reading', not zero."""
        assert rule().read(keypoints(0.5, v=0.2, far_v=0.2)) is None

    def test_a_missing_arm_produces_no_reading(self):
        frame = keypoints(0.5)
        for name in ("left_elbow", "right_elbow"):
            frame.pop(name)
        assert rule().read(frame) is None

    def test_one_missing_arm_falls_back_to_the_other(self):
        frame = keypoints(0.5)
        frame.pop("left_elbow")
        reading = rule().read(frame)
        assert reading is not None and reading.side == "right"


class TestBaselineIsRejectedWhenUnusable:
    def test_bent_arms_at_capture_are_rejected(self):
        """A baseline taken mid-push-up has no usable zero point."""
        with pytest.raises(ValueError, match="captured extended"):
            PushUpDepthRule(
                baseline(),
                target_elbow_angle_deg=TARGET_ELBOW_DEG,
                full_rom_gate=GATE,
                # The fixture's captured angle is 175; demand more than that.
                min_baseline_elbow_angle_deg=BASELINE_ELBOW_DEG + 2.0,
                min_upper_arm_px=40.0,
            )

    def test_standing_too_far_away_is_rejected(self):
        with pytest.raises(ValueError, match="captured extended"):
            rule(min_upper_arm_px=500.0)

    def test_an_impossible_target_is_rejected(self):
        with pytest.raises(ValueError, match="min_baseline_elbow_angle_deg must exceed"):
            rule(target_elbow_angle_deg=150.0, min_baseline_elbow_angle_deg=140.0)

    def test_a_non_positive_gate_is_rejected(self):
        with pytest.raises(ValueError, match="full ROM gate must be positive"):
            rule(full_rom_gate=0.0)

    def test_the_captured_angles_are_exposed_for_metadata(self):
        angles = rule().baseline_elbow_angles_deg
        assert set(angles) == {"left", "right"}
        assert angles["left"] == pytest.approx(BASELINE_ELBOW_DEG, abs=0.5)
