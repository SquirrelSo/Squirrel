"""Phase 4 tests for the independent, measurement-only High Knee ROM signal."""

from __future__ import annotations

from copy import deepcopy
from math import cos, radians, sin
from pathlib import Path

import pytest

from backend.engine.loader import validate_exercise_config
from backend.workouts.high_knee.rules.knee_drive_rom import (
    KneeDriveReading,
    KneeDriveRomRule,
)

_PACKAGE = Path(__file__).resolve().parents[1] / "workouts" / "high_knee"
_GATE = 0.90
_MIN_GAP = 40.0
_MIN_TORSO = 50.0


def _baseline() -> dict:
    # Image y grows down. Torso length=150px and each standing hip→knee projected gap=150px.
    return {
        "left_shoulder": {"x": 250.0, "y": 100.0, "v": 0.9},
        "right_shoulder": {"x": 150.0, "y": 100.0, "v": 0.9},
        "left_hip": {"x": 230.0, "y": 250.0, "v": 0.9},
        "right_hip": {"x": 170.0, "y": 250.0, "v": 0.9},
        "left_knee": {"x": 230.0, "y": 400.0, "v": 0.9},
        "right_knee": {"x": 170.0, "y": 400.0, "v": 0.9},
    }


def _rule(baseline: dict | None = None) -> KneeDriveRomRule:
    return KneeDriveRomRule(
        baseline or _baseline(),
        _GATE,
        min_baseline_gap_px=_MIN_GAP,
        min_torso_length_px=_MIN_TORSO,
    )


def _translated(points: dict, dx: float, dy: float) -> dict:
    result = deepcopy(points)
    for point in result.values():
        point["x"] += dx
        point["y"] += dy
    return result


def _rotated(points: dict, angle_deg: float, origin=(0.0, 0.0)) -> dict:
    result = deepcopy(points)
    theta = radians(angle_deg)
    c, s = cos(theta), sin(theta)
    for point in result.values():
        x, y = point["x"] - origin[0], point["y"] - origin[1]
        point["x"] = origin[0] + x * c - y * s
        point["y"] = origin[1] + x * s + y * c
    return result


def test_baseline_is_zero_for_both_sides():
    reading = _rule().read(_baseline())
    assert reading.left_progress_raw == pytest.approx(0.0)
    assert reading.right_progress_raw == pytest.approx(0.0)
    assert reading.left_available and reading.right_available


def test_shallow_and_hip_height_poses_are_separated_independently():
    frame = _baseline()
    frame["left_knee"]["y"] = 325.0  # half of the baseline gap remains
    frame["right_knee"]["y"] = 250.0  # knee exactly at live hip height

    reading = _rule().read(frame)
    assert reading.left_progress_raw == pytest.approx(0.5)
    assert reading.right_progress_raw == pytest.approx(1.0)
    assert _rule().is_full_rom(reading.left_progress_raw) is False
    assert _rule().is_full_rom(reading.right_progress_raw) is True


def test_whole_image_translation_does_not_change_progress():
    frame = _baseline()
    frame["left_knee"]["y"] = 295.0
    before = _rule().read(frame)
    after = _rule().read(_translated(frame, 137.0, -82.0))
    assert after.left_progress_raw == pytest.approx(before.left_progress_raw)
    assert after.right_progress_raw == pytest.approx(before.right_progress_raw)


def test_rigid_image_rotation_does_not_change_progress():
    frame = _baseline()
    frame["left_knee"]["y"] = 295.0
    before = _rule().read(frame)
    after = _rule().read(_rotated(frame, 23.0, origin=(200.0, 250.0)))
    assert after.left_progress_raw == pytest.approx(before.left_progress_raw)
    assert after.right_progress_raw == pytest.approx(before.right_progress_raw)


def test_whole_body_vertical_bounce_without_knee_lift_stays_zero():
    reading = _rule().read(_translated(_baseline(), 0.0, -45.0))
    assert reading.left_progress_raw == pytest.approx(0.0)
    assert reading.right_progress_raw == pytest.approx(0.0)


def test_standing_further_from_the_camera_than_at_setup_still_reads_standing():
    # An 80% live image scale turns a standing 150px gap into 120px. Uncompensated, that read as
    # 0.2 of a lift while standing, close to the reset band, so lifts stopped completing. The live
    # torso length carries the same 80%, and rescaling by it reads standing as 0.
    frame = _baseline()
    for point in frame.values():
        point["x"] *= 0.8
        point["y"] *= 0.8
    reading = _rule().read(frame)
    assert reading.left_progress_raw == pytest.approx(0.0)
    assert reading.right_progress_raw == pytest.approx(0.0)


def test_shoulders_out_of_frame_still_read_the_knees():
    frame = _baseline()
    del frame["left_shoulder"]
    frame["right_shoulder"]["v"] = 0.1
    frame["left_knee"]["y"] = 250.0 + 150.0 * 0.4   # knee 60% of the way up
    reading = _rule().read(frame)
    assert reading.left_available and reading.right_available
    assert reading.left_progress_raw == pytest.approx(0.6)
    assert reading.right_progress_raw == pytest.approx(0.0)


def test_raw_values_outside_display_range_are_preserved_and_display_clamped():
    frame = _baseline()
    frame["left_knee"]["y"] = 205.0  # above hip: raw 1.3
    frame["right_knee"]["y"] = 415.0  # below baseline: raw -0.1
    reading = _rule().read(frame)
    assert reading.left_progress_raw == pytest.approx(1.3)
    assert reading.right_progress_raw == pytest.approx(-0.1)
    assert reading.left_progress_display == pytest.approx(1.0)
    assert reading.right_progress_display == pytest.approx(0.0)


def test_one_bad_knee_does_not_hide_the_other_leg():
    frame = _baseline()
    frame["left_knee"]["v"] = 0.1
    frame["right_knee"]["y"] = 295.0
    reading = _rule().read(frame)
    assert reading.left_available is False
    assert reading.left_progress_raw is None
    assert reading.left_progress_display is None
    assert reading.right_available is True
    assert reading.right_progress_raw == pytest.approx(0.7)


@pytest.mark.parametrize("field", ["x", "y", "v"])
def test_nonfinite_knee_is_unavailable_only_on_that_side(field):
    frame = _baseline()
    frame["right_knee"][field] = float("nan")
    reading = _rule().read(frame)
    assert reading.left_available is True
    assert reading.right_available is False
    assert reading.right_progress_raw is None


def test_missing_knee_is_unavailable_only_on_that_side():
    frame = _baseline()
    del frame["left_knee"]
    reading = _rule().read(frame)
    assert reading.left_available is False
    assert reading.right_available is True


def test_collapsed_torso_falls_back_to_image_up_but_nonfinite_hips_are_unavailable():
    collapsed = _baseline()
    collapsed["left_shoulder"].update(collapsed["left_hip"])
    collapsed["right_shoulder"].update(collapsed["right_hip"])
    reading = _rule().read(collapsed)
    assert reading.left_available and reading.right_available
    assert reading.left_progress_raw == pytest.approx(0.0)

    nonfinite = _baseline()
    nonfinite["left_hip"]["v"] = float("nan")
    reading = _rule().read(nonfinite)
    assert not reading.left_available and not reading.right_available


def test_knee_overlapping_hip_is_valid_target_not_collapsed_geometry():
    frame = _baseline()
    frame["left_knee"]["x"] = frame["left_hip"]["x"]
    frame["left_knee"]["y"] = frame["left_hip"]["y"]
    reading = _rule().read(frame)
    assert reading.left_available is True
    assert reading.left_progress_raw == pytest.approx(1.0)


def test_comfortable_torso_only_lean_stays_below_movement_start_release_margin():
    # Numeric release gate from the V2 review: with knees/hips stationary, rotate only the torso
    # by 30 degrees around the hip midpoint. Expected false progress ~= 0.134 < start 0.15.
    frame = _baseline()
    shoulders = {
        name: point
        for name, point in frame.items()
        if name in {"left_shoulder", "right_shoulder"}
    }
    rotated_shoulders = _rotated(shoulders, 30.0, origin=(200.0, 250.0))
    frame.update(rotated_shoulders)
    reading = _rule().read(frame)
    movement_start = validate_exercise_config("high_knee", _PACKAGE).fsm[
        "movement_start"
    ]
    assert reading.left_progress_raw == pytest.approx(1.0 - cos(radians(30.0)))
    assert reading.right_progress_raw == pytest.approx(reading.left_progress_raw)
    assert reading.left_progress_raw < movement_start


def test_constructor_rejects_bad_baseline_and_bad_thresholds():
    small_gap = _baseline()
    small_gap["left_knee"]["y"] = 275.0
    with pytest.raises(ValueError, match="left hip-to-knee projected gap"):
        _rule(small_gap)

    collapsed_torso = _baseline()
    collapsed_torso["left_shoulder"].update(collapsed_torso["left_hip"])
    collapsed_torso["right_shoulder"].update(collapsed_torso["right_hip"])
    with pytest.raises(ValueError, match="torso axis"):
        _rule(collapsed_torso)

    with pytest.raises(ValueError, match="full ROM gate"):
        KneeDriveRomRule(
            _baseline(),
            0.0,
            min_baseline_gap_px=_MIN_GAP,
            min_torso_length_px=_MIN_TORSO,
        )


def test_reading_is_immutable_and_baseline_gaps_are_exposed():
    rule = _rule()
    reading = rule.read(_baseline())
    assert isinstance(reading, KneeDriveReading)
    assert rule.full_rom_gate == pytest.approx(_GATE)
    assert rule.baseline_gap_px("left") == pytest.approx(150.0)
    assert rule.baseline_gap_px("right") == pytest.approx(150.0)
    with pytest.raises(ValueError, match="side must be"):
        rule.baseline_gap_px("middle")
    with pytest.raises(Exception):
        reading.left_progress_raw = 99.0
