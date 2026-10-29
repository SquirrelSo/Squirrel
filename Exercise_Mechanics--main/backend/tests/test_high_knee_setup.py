"""Phase 3 High Knee front-view readiness, baseline geometry, and setup flow."""

from __future__ import annotations

from math import cos, radians, sin
from pathlib import Path

import pytest

from backend.engine.loader import validate_exercise_config
from backend.training.baseline import BaselineQuality
from backend.training.setup_config import build_setup_config
from backend.training.setup_flow import PRECHECK, READY, VALIDATING, SetupOrchestrator
from backend.workouts.high_knee.setup_adapter import HighKneeSetupAdapter

_PACKAGE = Path(__file__).resolve().parents[1] / "workouts" / "high_knee"
_CONFIG = validate_exercise_config("high_knee", _PACKAGE)
_TEMPLATES = ("setup_readiness",)


def _point(x: float, y: float, visibility: float = 0.99) -> dict:
    return {"x": x, "y": y, "v": visibility}


def _frame() -> dict:
    return {
        "left_shoulder": _point(250.0, 100.0),
        "right_shoulder": _point(150.0, 100.0),
        "left_hip": _point(230.0, 250.0),
        "right_hip": _point(170.0, 250.0),
        "left_knee": _point(230.0, 400.0),
        "right_knee": _point(170.0, 400.0),
        "left_ankle": _point(240.0, 550.0),
        "right_ankle": _point(160.0, 550.0),
    }


def _reference(frame: dict | None = None) -> dict:
    return {
        name: {"x": point["x"], "y": point["y"]}
        for name, point in (frame or _frame()).items()
    }


def _quality(**changes: object) -> BaselineQuality:
    values = {
        "valid_samples": 61,
        "observed_frames": 61,
        "valid_coverage": 1.0,
        "valid_duration_ms": 3000.0,
        "max_joint_stddev_px": 0.0,
        "body_scale_px": 150.0,
        "max_joint_stddev_rel": 0.0,
        "joint_stddev_px": {
            name: {"x": 0.0, "y": 0.0} for name in _frame()
        },
    }
    values.update(changes)
    return BaselineQuality(**values)


def _adapter() -> HighKneeSetupAdapter:
    return HighKneeSetupAdapter(_CONFIG)


def _reading(frame: dict | None = None):
    return _adapter().evaluate(_TEMPLATES, frame or _frame())[0]


def _transform(frame: dict, *, tx: float, ty: float, angle_deg: float) -> dict:
    angle = radians(angle_deg)
    cosine, sine = cos(angle), sin(angle)
    transformed = {}
    for name, point in frame.items():
        x = point["x"] * cosine - point["y"] * sine + tx
        y = point["x"] * sine + point["y"] * cosine + ty
        transformed[name] = _point(x, y, point["v"])
    return transformed


def test_valid_front_view_setup_exposes_every_baseline_reference():
    result = _reading()

    assert result.passed
    assert result.cue is None
    assert result.measurements["shoulder_midpoint"] == {"x": 200.0, "y": 100.0}
    assert result.measurements["hip_midpoint"] == {"x": 200.0, "y": 250.0}
    assert result.measurements["shoulder_width_px"] == 100.0
    assert result.measurements["hip_width_px"] == 60.0
    assert result.measurements["body_up_axis"] == {"x": 0.0, "y": -1.0}
    assert result.measurements["body_lateral_axis"] == {"x": 1.0, "y": 0.0}
    assert result.measurements["hip_to_knee_resting_gap_px"] == {
        "left": 150.0,
        "right": 150.0,
    }
    assert set(result.measurements["resting_knee_lateral_offset_px"]) == {
        "left",
        "right",
    }
    assert set(result.measurements["resting_ankle_lateral_offset_px"]) == {
        "left",
        "right",
    }


def test_cropped_or_low_confidence_setup_is_unavailable_with_a_cue():
    cropped = _frame()
    del cropped["left_ankle"]
    hidden = _frame()
    hidden["right_knee"]["v"] = 0.2

    for frame in (cropped, hidden):
        result = _reading(frame)
        assert result.status == "unavailable"
        assert result.reason_id == "setup_geometry_unavailable"
        assert result.cue


def test_collapsed_or_nonfinite_geometry_is_unavailable_not_an_exception():
    collapsed = _frame()
    collapsed["left_shoulder"] = _point(200.0, 250.0)
    collapsed["right_shoulder"] = _point(200.0, 250.0)
    nonfinite = _frame()
    nonfinite["left_hip"]["x"] = float("nan")

    assert _reading(collapsed).status == "unavailable"
    assert _reading(nonfinite).status == "unavailable"


def test_narrow_bilateral_geometry_or_inconsistent_orientation_fails_front_view():
    narrow = _frame()
    for joint, left_x, right_x in (
        ("shoulder", 210.0, 190.0),
        ("hip", 205.0, 195.0),
        ("knee", 205.0, 195.0),
        ("ankle", 208.0, 192.0),
    ):
        narrow[f"left_{joint}"]["x"] = left_x
        narrow[f"right_{joint}"]["x"] = right_x
    crossed = _frame()
    crossed["left_ankle"]["x"], crossed["right_ankle"]["x"] = (
        crossed["right_ankle"]["x"],
        crossed["left_ankle"]["x"],
    )

    assert _reading(narrow).reason_id == "not_front_facing"
    assert _reading(crossed).reason_id == "not_front_facing"


def test_bent_knees_raised_foot_and_unstable_stance_have_distinct_reasons():
    bent = _frame()
    bent["left_knee"]["x"] = 280.0
    bent["right_knee"]["x"] = 120.0
    raised = _frame()
    raised["left_ankle"]["y"] = 510.0
    wide = _frame()
    wide["left_ankle"]["x"] = 320.0
    wide["right_ankle"]["x"] = 80.0
    wide["left_knee"]["x"] = 275.0      # legs still straight, just spread wide
    wide["right_knee"]["x"] = 125.0

    assert _reading(bent).reason_id == "knees_not_extended"
    assert _reading(raised).reason_id == "both_feet_not_down"
    assert _reading(wide).reason_id == "starting_stance_unstable"


def test_setup_geometry_is_translation_and_modest_roll_stable():
    original = _reading()
    transformed = _reading(_transform(_frame(), tx=350.0, ty=-90.0, angle_deg=12.0))

    assert transformed.passed
    for field in (
        "shoulder_width_px",
        "hip_width_px",
        "torso_length_px",
        "stance_ratio",
        "foot_height_difference_ratio",
        "side_length_ratio",
    ):
        assert transformed.measurements[field] == pytest.approx(
            original.measurements[field], abs=1e-3
        )
    assert transformed.measurements["hip_to_knee_resting_gap_px"] == pytest.approx(
        original.measurements["hip_to_knee_resting_gap_px"], abs=1e-3
    )


def test_baseline_validation_rejects_bad_quality_and_accepts_stable_reference():
    good = _adapter().validate_baseline(_reference(), _quality(), _TEMPLATES)
    unstable = _adapter().validate_baseline(
        _reference(),
        _quality(max_joint_stddev_px=30.0, max_joint_stddev_rel=0.2),
        _TEMPLATES,
    )
    incomplete = _adapter().validate_baseline(
        _reference(),
        _quality(valid_samples=20, valid_coverage=0.5),
        _TEMPLATES,
    )
    contradictory = _adapter().validate_baseline(
        _reference(),
        _quality(valid_samples=61, observed_frames=50, valid_coverage=1.0),
        _TEMPLATES,
    )

    assert good.passed
    assert tuple(result.template_id for result in good.results) == (
        "setup_readiness",
        "baseline_quality",
    )
    assert not unstable.passed
    assert unstable.results[-1].reason_id == "baseline_unstable_or_incomplete"
    assert not incomplete.passed
    assert not contradictory.passed


def test_real_setup_flow_completes_deterministically_after_dwell_and_capture():
    orchestrator = SetupOrchestrator(build_setup_config(_CONFIG), _adapter())
    status = None
    for timestamp in range(0, 5051, 50):
        status = orchestrator.update(_frame(), float(timestamp))

    assert status is not None and status.phase == VALIDATING
    assert status.frames_collected >= 45
    assert status.valid_coverage == 1.0
    assert orchestrator.baseline is not None
    ready = orchestrator.mark_ready()
    assert ready.phase == READY
    assert ready.baseline_ready is True


def test_cropped_setup_never_opens_capture_and_motion_rejects_baseline():
    cropped_orchestrator = SetupOrchestrator(build_setup_config(_CONFIG), _adapter())
    cropped = _frame()
    del cropped["right_ankle"]
    for timestamp in range(0, 4001, 100):
        cropped_status = cropped_orchestrator.update(cropped, float(timestamp))
    assert cropped_status.phase == PRECHECK
    assert "right_ankle" in cropped_status.missing

    moving_orchestrator = SetupOrchestrator(build_setup_config(_CONFIG), _adapter())
    for timestamp in range(0, 2001, 50):
        moving_orchestrator.update(_frame(), float(timestamp))
    moving_status = None
    for index, timestamp in enumerate(range(2050, 5051, 50)):
        shifted = _transform(
            _frame(),
            tx=20.0 if index % 2 else -20.0,
            ty=0.0,
            angle_deg=0.0,
        )
        moving_status = moving_orchestrator.update(shifted, float(timestamp))

    assert moving_status is not None and moving_status.phase == PRECHECK
    assert moving_orchestrator.baseline is None
    assert moving_status.validation_results[0].reason_id == "baseline_unstable"
