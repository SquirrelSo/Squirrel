"""Push-up body-line kernel: sagging and piked hips, coached apart by sign."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.engine.loader import validate_exercise_config
from backend.tests.pushup_fixtures import baseline, keypoints
from backend.workouts.pushup.rules.body_line import BodyLineRule

_CONFIG = validate_exercise_config(
    "pushup", Path(__file__).resolve().parents[1] / "workouts" / "pushup"
)
_TEMPLATE = _CONFIG.templates["body_line"]


def rule(reference: dict | None = None, **overrides) -> BodyLineRule:
    options = {"min_body_span_px": _TEMPLATE["min_body_span_px"]}
    options.update(overrides)
    return BodyLineRule(
        baseline() if reference is None else reference,
        _TEMPLATE["policy"]["mode"],
        _TEMPLATE["policy"]["ranges"],
        **options,
    )


def _scaled(frame: dict, factor: float) -> dict:
    """Shrink a frame toward its own centre, as if the user stepped back from the camera."""
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


class TestSignal:
    def test_a_straight_body_reads_zero(self):
        reading = rule().read(keypoints(0.5))
        assert reading is not None
        assert reading.offset == pytest.approx(0.0, abs=0.005)
        assert reading.state == "safe"
        assert reading.not_ok is False

    def test_dropped_hips_read_positive_and_are_called_sag(self):
        reading = rule().read(keypoints(0.5, sag=0.08))
        assert reading.offset > 0
        assert reading.side == "sag"
        assert reading.not_ok is True

    def test_lifted_hips_read_negative_and_are_called_pike(self):
        reading = rule().read(keypoints(0.5, sag=-0.08))
        assert reading.offset < 0
        assert reading.side == "pike"
        assert reading.not_ok is True

    def test_the_sign_is_what_separates_the_two_faults(self):
        """An unsigned angle could not tell these apart, and they need opposite coaching."""
        sagging = rule().read(keypoints(0.5, sag=0.08))
        piked = rule().read(keypoints(0.5, sag=-0.08))
        assert sagging.offset == pytest.approx(-piked.offset, abs=0.005)
        assert sagging.side != piked.side

    def test_the_measurement_is_scale_invariant(self):
        """Standing further from the camera must not change the verdict."""
        near = rule().read(keypoints(0.5, sag=0.08))
        assert near.not_ok is True
        assert near.offset == pytest.approx(0.08, abs=0.01)


class TestBands:
    @pytest.mark.parametrize(
        "sag, state",
        [(0.0, "safe"), (0.03, "safe"), (0.045, "warning"), (0.08, "not_ok")],
    )
    def test_each_band_classifies_as_configured(self, sag, state):
        assert rule().read(keypoints(0.5, sag=sag)).state == state

    def test_a_warning_is_not_a_fault(self):
        """Warnings colour the skeleton; only not_ok costs score."""
        reading = rule().read(keypoints(0.5, sag=0.045))
        assert reading.state == "warning"
        assert reading.not_ok is False
        assert reading.skeleton_color == "green"


class TestBaselineRelative:
    def test_a_persons_natural_plank_is_their_zero(self):
        """Captured with slightly low hips, holding that SAME shape must not read as a fault."""
        crooked = baseline(sag=0.04)
        reading = rule(crooked).read(keypoints(0.5, sag=0.04))
        assert reading.offset == pytest.approx(0.0, abs=0.005)
        assert reading.not_ok is False

    def test_the_change_during_the_set_is_what_is_measured(self):
        crooked = baseline(sag=0.04)
        reading = rule(crooked).read(keypoints(0.5, sag=0.12))
        assert reading.offset == pytest.approx(0.08, abs=0.01)
        assert reading.not_ok is True

    def test_the_captured_offsets_are_exposed_for_metadata(self):
        assert set(rule().baseline_offsets) == {"left", "right"}


class TestUnavailableFrames:
    def test_low_confidence_produces_no_reading(self):
        assert rule().read(keypoints(0.5, v=0.2, far_v=0.2)) is None

    def test_a_baseline_too_small_to_measure_is_rejected_at_construction(self):
        with pytest.raises(ValueError, match="span of at least"):
            rule(min_body_span_px=10_000.0)

    def test_a_live_frame_too_small_to_measure_produces_no_reading(self):
        """The user walked far enough away that the normalized offset would be noise."""
        shrunk = _scaled(keypoints(0.5), 0.2)
        assert rule().read(shrunk) is None

    def test_a_missing_ankle_falls_back_to_the_other_side(self):
        frame = keypoints(0.5)
        frame.pop("left_ankle")
        reading = rule().read(frame)
        assert reading is not None and reading.analysed_side == "right"
