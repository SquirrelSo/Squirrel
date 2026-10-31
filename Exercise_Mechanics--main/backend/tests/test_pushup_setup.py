"""Push-up setup conditions and baseline validation."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.engine.loader import validate_exercise_config
from backend.tests.pushup_fixtures import FRONT_ON_LATERAL_PX, baseline, keypoints
from backend.training.baseline import BaselineQuality
from backend.workouts.pushup.setup_adapter import (
    PushUpSetupAdapter,
    build_pushup_setup_adapter,
)

_CONFIG = validate_exercise_config(
    "pushup", Path(__file__).resolve().parents[1] / "workouts" / "pushup"
)
_TEMPLATES = ("plank_ready", "side_view_orientation")


@pytest.fixture
def adapter() -> PushUpSetupAdapter:
    return PushUpSetupAdapter(_CONFIG)


def by_id(results) -> dict:
    return {result.template_id: result for result in results}


class TestPreCheck:
    def test_a_correct_plank_passes_every_condition(self, adapter):
        results = by_id(adapter.evaluate(_TEMPLATES, keypoints(0.0)))
        assert all(result.passed for result in results.values())

    def test_bent_arms_fail_with_an_actionable_reason(self, adapter):
        results = by_id(adapter.evaluate(_TEMPLATES, keypoints(0.6)))
        assert results["plank_ready"].status == "failed"
        assert results["plank_ready"].reason_id == "arms_not_extended"
        assert results["plank_ready"].cue

    def test_a_sagging_setup_is_refused(self, adapter):
        """Absolute, not baseline-relative: this is what stops a bad zero point being captured."""
        results = by_id(adapter.evaluate(_TEMPLATES, keypoints(0.0, sag=0.12)))
        assert results["plank_ready"].reason_id == "body_not_straight"

    def test_a_front_on_camera_is_refused_immediately(self, adapter):
        results = by_id(
            adapter.evaluate(_TEMPLATES, keypoints(0.0, lateral=FRONT_ON_LATERAL_PX, far_v=0.9))
        )
        assert results["side_view_orientation"].status == "failed"
        assert results["side_view_orientation"].reason_id == "camera_not_side_on"

    def test_untracked_landmarks_report_unavailable_not_failed(self, adapter):
        """"We cannot see you" is a different message from "you are in the wrong position"."""
        results = by_id(adapter.evaluate(_TEMPLATES, keypoints(0.0, v=0.2, far_v=0.2)))
        assert {result.status for result in results.values()} == {"unavailable"}

    def test_measurements_are_returned_for_the_live_ui(self, adapter):
        results = by_id(adapter.evaluate(_TEMPLATES, keypoints(0.0)))
        plank = results["plank_ready"].measurements
        assert plank["arms_extended"] is True
        assert plank["analysed_side"] in ("left", "right")
        assert "spread_ratio" in results["side_view_orientation"].measurements


class TestBaselineValidation:
    def test_a_good_capture_is_accepted(self, adapter):
        validation = adapter.validate_baseline(baseline(), _quality(), _TEMPLATES)
        assert validation.passed is True
        checks = by_id(validation.results)
        assert checks["depth_reference"].passed
        assert set(checks["depth_reference"].measurements["usable_sides"]) == {"left", "right"}

    def test_a_capture_the_depth_rule_cannot_use_is_rejected(self, adapter):
        """The check IS the live rule's constructor, so setup and training cannot disagree."""
        validation = adapter.validate_baseline(baseline(0.8), _quality(), _TEMPLATES)
        checks = by_id(validation.results)
        assert validation.passed is False
        assert checks["depth_reference"].reason_id == "baseline_depth_reference_unavailable"

    def test_a_front_on_capture_is_rejected(self, adapter):
        validation = adapter.validate_baseline(
            baseline(lateral=FRONT_ON_LATERAL_PX), _quality(), _TEMPLATES
        )
        assert validation.passed is False

    def test_the_builder_loads_the_real_configuration(self):
        built = build_pushup_setup_adapter()
        assert built.evaluate(_TEMPLATES, keypoints(0.0))[0].passed


def _quality() -> BaselineQuality:
    """Capture quality is the orchestrator's concern; these conditions ignore it."""
    return BaselineQuality(
        valid_samples=45,
        observed_frames=50,
        valid_coverage=0.9,
        valid_duration_ms=3_000.0,
        max_joint_stddev_px=2.0,
        joint_stddev_px={},
    )
