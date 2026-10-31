"""Squat adapter integration over rules, FSM, timeline, scorer and cues."""

from __future__ import annotations

from math import radians, tan

import pytest

from backend.core.frame import TrainingFrame
from backend.training.builders import EXERCISE_BUILDERS, validate_training_builders
from backend.workouts.squat.adapter import build_squat_adapter

# Synthetic reps here are faster and shallower than the live counting policy accepts (conftest).
pytestmark = pytest.mark.usefixtures("legacy_rep_counting")


def _baseline() -> dict:
    return {
        name: {axis: value for axis, value in landmark.items() if axis != "v"}
        for name, landmark in _keypoints(0.0).items()
    }


def _keypoints(
    progress: float,
    *,
    ankle_width: float = 100.0,
    knee_inset: float = 0.0,
    torso_lean_deg: float = 0.0,
    shoulder_width: float = 100.0,
    include_shoulders: bool = True,
) -> dict:
    center = 200.0
    hip_y = 100.0 + progress * 100.0
    points = {
        "left_hip": {"x": 220.0, "y": hip_y, "v": 0.9},
        "right_hip": {"x": 180.0, "y": hip_y, "v": 0.9},
        "left_knee": {"x": 220.0 - knee_inset, "y": 200.0, "v": 0.9},
        "right_knee": {"x": 180.0 + knee_inset, "y": 200.0, "v": 0.9},
        "left_ankle": {"x": center + ankle_width / 2, "y": 300.0, "v": 0.9},
        "right_ankle": {"x": center - ankle_width / 2, "y": 300.0, "v": 0.9},
    }
    if include_shoulders:
        shoulder_shift = tan(radians(torso_lean_deg)) * (hip_y - 50.0)
        points.update(
            {
                "left_shoulder": {
                    "x": center + shoulder_width / 2 + shoulder_shift,
                    "y": 50.0,
                    "v": 0.9,
                },
                "right_shoulder": {
                    "x": center - shoulder_width / 2 + shoulder_shift,
                    "y": 50.0,
                    "v": 0.9,
                },
            }
        )
    return points


def _frame(
    progress: float,
    timestamp: float,
    *,
    ankle_width: float = 100.0,
    knee_inset: float = 0.0,
    torso_lean_deg: float = 0.0,
    shoulder_width: float = 100.0,
    include_shoulders: bool = True,
) -> TrainingFrame:
    return TrainingFrame(
        timestamp,
        _keypoints(
            progress,
            ankle_width=ankle_width,
            knee_inset=knee_inset,
            torso_lean_deg=torso_lean_deg,
            shoulder_width=shoulder_width,
            include_shoulders=include_shoulders,
        ),
    )


_FULL = [(0.0, 0), (0.3, 100), (0.6, 200), (0.9, 300), (0.95, 400), (0.9, 500), (0.7, 600), (0.3, 700), (0.05, 800)]
_SHALLOW = [(0.0, 0), (0.3, 100), (0.6, 200), (0.7, 300), (0.5, 400), (0.3, 500), (0.05, 600)]
_INVALID = [(0.0, 0), (0.28, 100), (0.35, 200), (0.3, 300), (0.27, 400), (0.05, 500)]


def _drive(adapter, sequence, **frame_options):
    status = None
    for progress, timestamp in sequence:
        status = adapter.process(_frame(progress, timestamp, **frame_options))
    assert status is not None
    return status


def test_clean_full_rep_streams_reliable_score_and_completes_one_rep_set():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=1)
    status = _drive(adapter, _FULL)

    assert status["counters"] == {
        "attempts": 1,
        "qualified": 1,
        "full_rom": 1,
        "shallow": 0,
        "invalid": 0,
        "not_counted": {"shallow": 0, "too_fast": 0},
    }
    assert status["last_rep"]["classification"] == "full_rom"
    assert status["last_rep"]["score"] == 100.0
    assert status["last_rep"]["quality"] == "reliable"
    assert status["score_coverage"] == {
        "active_rule_ids": ["knee_valgus", "lateral_torso_lean", "depth"],
        "available_rule_ids": ["knee_valgus", "lateral_torso_lean", "depth"],
        "unavailable_rule_ids": [],
        "ratio": 1.0,
        "reliable": True,
    }
    assert status["set"] == {
        "target_reps": 1,
        "completed_reps": 1,
        "remaining_reps": 0,
        "complete": True,
        "scored_reps": 1,
        "average_score": 100.0,
    }


def test_final_set_cycle_completes_only_after_configured_reset_transition():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=1)
    scored = _drive(adapter, _FULL)
    assert scored["set"]["complete"] is True
    assert scored["events"]["set_cycle_completed"] is False

    reset_finished = None
    for timestamp in (850, 900):
        reset_finished = adapter.process(_frame(0.0, timestamp))

    assert reset_finished is not None
    assert reset_finished["phase"] == "setup"
    assert reset_finished["events"]["rep_cycle_completed"] is True
    assert reset_finished["events"]["set_cycle_completed"] is True
    assert adapter.debug_snapshot()["start_new_rep"] is False


def test_shallow_rep_emits_500ms_depth_cue_at_start_of_next_rep():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    status = _drive(adapter, _SHALLOW)

    assert status["counters"]["qualified"] == 1
    assert status["counters"]["shallow"] == 1
    assert status["last_rep"]["classification"] == "shallow"
    assert status["last_rep"]["rom_factor"] == pytest.approx(0.7 / 0.85)
    assert status["last_rep"]["score"] == 82.4
    # The shallow rep counts, and is warned about at once.
    assert status["cue"]["text"] == "Shallow rep: Go to the target depth with control."
    assert status["set"]["completed_reps"] == 1

    setup = None
    for timestamp in range(700, 3301, 100):
        setup = adapter.process(_frame(0.0, timestamp))
    assert setup is not None
    assert setup["phase"] == "setup"
    assert setup["cue"] is None

    descent = adapter.process(_frame(0.3, 3400))
    assert descent["phase"] == "descent"
    assert descent["cue"]["rule_id"] == "depth"
    assert adapter.process(_frame(0.4, 3899))["cue"]["rule_id"] == "depth"
    assert adapter.process(_frame(0.5, 3900))["cue"] is None


def test_final_shallow_rep_does_not_queue_a_next_rep_depth_cue():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=1)
    assert _drive(adapter, _SHALLOW)["cue"]["text"].startswith("Shallow rep:")
    for timestamp in range(3300, 3700, 100):
        assert adapter.process(_frame(0.0, timestamp))["cue"] is None
    assert adapter.process(_frame(0.3, 3700))["cue"] is None


def test_invalid_micro_attempt_has_no_score_or_set_progress():
    status = _drive(
        build_squat_adapter(baseline=_baseline(), target_reps=3),
        _INVALID,
    )
    assert status["counters"]["attempts"] == 1
    assert status["counters"]["invalid"] == 1
    assert status["counters"]["qualified"] == 0
    assert status["last_attempt"]["classification"] == "invalid"
    assert status["last_attempt"]["score"] is None
    assert status["last_attempt"]["quality"] == "not_scored"
    assert status["last_rep"] is None
    assert status["score_coverage"] is None
    assert status["set"]["completed_reps"] == 0
    assert status["set"]["scored_reps"] == 0


def test_setup_stance_fault_emits_issue_but_never_scores_the_rep():
    status = _drive(
        build_squat_adapter(baseline=_baseline(), target_reps=3),
        _FULL,
        ankle_width=60.0,
    )
    assert status["last_rep"]["score"] == 100.0
    assert status["last_rep"]["time_score"] == 100.0
    # Monitoring begins in setup, so the cue has satisfied its minimum display time by reset.
    assert status["issues"] == []
    assert status["cue"] is None


def test_live_knee_valgus_uses_person_baseline_and_configured_penalty_weight():
    status = _drive(
        build_squat_adapter(baseline=_baseline(), target_reps=3),
        _FULL,
        knee_inset=20.0,
    )

    assert status["last_rep"]["time_score"] == 50.0
    assert status["last_rep"]["score"] == 50.0
    assert status["cue"]["rule_id"] == "knee_valgus"
    knee = status["last_rep"]["phase_scores"]["bottom"]["rules"]["knee_valgus"]
    assert knee["not_ok_fraction"] == 1.0


def test_knee_warning_is_silent_green_and_unscored():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=1)
    status = None
    for progress, timestamp in _FULL:
        status = adapter.process(_frame(progress, timestamp, knee_inset=0.25))
        assert all(issue["id"] != "knee_valgus" for issue in status["issues"])
        assert status["cue"] is None

    assert status is not None
    assert status["last_rep"]["score"] == 100.0
    reading = adapter.debug_snapshot()["rules"]["knee_valgus"]["result"]
    assert reading["state"] == "warning"
    assert reading["skeleton_color"] == "green"


def test_knee_valgus_has_no_setup_issue_or_score_phase():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)

    setup = adapter.process(_frame(0.0, 0, knee_inset=20.0))

    assert setup["phase"] == "setup"
    assert all(issue["id"] != "knee_valgus" for issue in setup["issues"])
    assert adapter.debug_snapshot()["rules"]["knee_valgus"]["phase_active"] is False


def test_lateral_torso_lean_warning_is_silent_green_and_unscored():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=1)
    status = None
    for progress, timestamp in _FULL:
        status = adapter.process(_frame(progress, timestamp, torso_lean_deg=4.0))
        assert all(issue["id"] != "lateral_torso_lean" for issue in status["issues"])
        assert status["cue"] is None

    assert status is not None
    assert status["last_rep"]["score"] == 100.0
    reading = adapter.debug_snapshot()["rules"]["lateral_torso_lean"]["result"]
    assert reading["state"] == "warning"
    assert reading["skeleton_color"] == "green"


@pytest.mark.parametrize(("torso_lean_deg", "side"), [(6.0, "left"), (-6.0, "right")])
def test_lateral_torso_lean_not_ok_emits_side_cue_red_skeleton_and_score_penalty(
    torso_lean_deg: float,
    side: str,
):
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=1)
    status = _drive(adapter, _FULL, torso_lean_deg=torso_lean_deg)

    assert status["last_rep"]["time_score"] == 70.0
    assert status["last_rep"]["score"] == 70.0
    assert status["cue"] == {
        "rule_id": "lateral_torso_lean",
        "text": "Keep your torso upright and centered.",
        "coaching": (
            "You were tipping to one side through the rep. Brace your core and keep your "
            "shoulders level so your torso stays stacked evenly over both hips — even weight, "
            "even effort."
        ),
    }
    reading = adapter.debug_snapshot()["rules"]["lateral_torso_lean"]["result"]
    assert reading["side"] == side
    assert reading["state"] == "not_ok"
    assert reading["skeleton_color"] == "red"


def test_live_setup_monitors_stance_but_setup_fault_never_enters_score():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    setup = adapter.process(_frame(0.0, 0, ankle_width=60.0))

    assert setup["phase"] == "setup"
    assert setup["issues"] == [
        {
            "id": "stance_width",
            "label": "Stance too narrow / too wide",
            "tier": "low",
            "side": "narrow",
            "state": "not_ok",
            "skeleton_color": "red",
        }
    ]
    assert setup["cue"]["rule_id"] == "stance_width"
    assert adapter.debug_snapshot()["rules"]["stance_width"]["phase_active"] is True

    status = None
    for progress, timestamp in _FULL:
        status = adapter.process(_frame(progress, timestamp + 100))
    assert status is not None
    assert status["last_rep"]["time_score"] == 100.0
    assert status["last_rep"]["score"] == 100.0


def test_live_stance_warning_is_green_and_does_not_emit_or_score_an_issue():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    setup = adapter.process(_frame(0.0, 0, ankle_width=75.0))

    assert setup["phase"] == "setup"
    assert setup["issues"] == []
    stance = adapter.debug_snapshot()["rules"]["stance_width"]["result"]
    assert stance["state"] == "warning"
    assert stance["skeleton_color"] == "green"

    status = _drive(adapter, _FULL, ankle_width=75.0)
    assert status["last_rep"]["time_score"] == 100.0
    assert status["last_rep"]["score"] == 100.0


def test_monitor_only_stance_unavailable_does_not_reduce_score_coverage():
    status = _drive(
        build_squat_adapter(baseline=_baseline(), target_reps=3),
        _FULL,
        shoulder_width=0.0,
    )
    assert status["last_rep"]["score"] == 100.0
    assert status["last_rep"]["quality"] == "reliable"
    assert status["score_coverage"]["available_rule_ids"] == [
        "knee_valgus",
        "lateral_torso_lean",
        "depth",
    ]
    assert status["score_coverage"]["unavailable_rule_ids"] == []
    assert status["score_coverage"]["ratio"] == 1.0


def test_tracking_dropout_pauses_then_compatible_recovery_completes():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    for progress, timestamp in _FULL[:5]:
        adapter.process(_frame(progress, timestamp))
    missing = _keypoints(0.9)
    missing.pop("left_hip")
    dropout = adapter.process(TrainingFrame(450, missing))
    adapter.process(_frame(0.9, 500))
    adapter.process(_frame(0.7, 600))
    adapter.process(_frame(0.5, 700))
    status = adapter.process(_frame(0.05, 800))

    assert dropout["tracking"]["available"] is False
    assert status["counters"]["qualified"] == 1
    assert status["counters"]["full_rom"] == 1


def test_long_tracking_gap_discards_partial_attempt_without_last_rep():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    adapter.process(_frame(0.0, 0))
    adapter.process(_frame(0.4, 30))
    adapter.process(_frame(0.9, 60))
    status = adapter.process(_frame(0.7, 1100))   # over a second without a frame

    assert status["events"]["attempt_discarded"] is True
    assert status["counters"]["attempts"] == 0
    assert status["last_rep"] is None


def test_default_adapter_constructs_only_active_ready_rules():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    assert adapter.active_rule_ids == (
        "knee_valgus",
        "lateral_torso_lean",
        "depth",
        "stance_width",
    )
    status = adapter.process(_frame(0.0, 0))
    assert "knee_valgus" in status["active_rule_ids"]
    assert "lateral_torso_lean" in status["active_rule_ids"]


def test_explicit_builder_registry_matches_enabled_catalog():
    assert set(EXERCISE_BUILDERS) == {"squat", "bicep_curl", "high_knee", "pushup"}
    assert validate_training_builders() == ("bicep_curl", "high_knee", "pushup", "squat")


# ---- Squats seen by real cameras (rules/depth.py) ------------------------------------------------

_SWEEP = [(0.0, 0), (0.3, 100), (0.6, 200), (0.9, 300), (0.95, 400), (0.9, 500), (0.6, 600), (0.3, 700), (0.0, 800)]


def _moved(points: dict, *, shift_y: float = 0.0, scale: float = 1.0, about_y: float = 400.0) -> dict:
    """The same standing body, as the camera sees it after moving: shifted down the frame (a phone
    sliding or tilting) or scaled about a point low in the frame (the person stepping back)."""
    return {
        name: {**p, "y": about_y + (p["y"] - about_y) * scale + shift_y}
        for name, p in points.items()
    }


def _real_squat(progress: float) -> dict:
    """A front-view squat as a camera records it: the hips drop, the shins tilt forward up to ~40°,
    so the knees drop a little and the shins look shorter. (_keypoints keeps knees and ankles fixed.)"""
    from math import cos
    points = _keypoints(progress)
    tilt = radians(40.0) * min(progress, 1.0)
    knee_drop = 100.0 * (1 - cos(tilt))
    for side in ("left_knee", "right_knee"):
        points[side] = {**points[side], "y": 200.0 + knee_drop}
    return points


def _drive_points(adapter, sequence, points_for):
    status = None
    for value, timestamp in sequence:
        status = adapter.process(TrainingFrame(timestamp, points_for(value)))
    return status


def test_realistic_squats_still_count_full_depth_including_near_the_gate():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    full = _drive_points(adapter, _SWEEP, _real_squat)
    assert full["last_rep"]["classification"] == "full_rom"

    rest = [(0.0, t) for t in range(900, 1500, 100)]   # the configured reset dwell (500 ms) at the top
    near_gate = rest + [(p, t + 1500) for p, t in [(0.3, 0), (0.6, 100), (0.87, 200), (0.87, 300), (0.6, 400), (0.3, 500), (0.0, 600)]]
    status = _drive_points(adapter, near_gate, _real_squat)
    assert status["last_rep"]["classification"] == "full_rom"
    assert status["counters"]["full_rom"] == 2
    assert status["set"]["completed_reps"] == 2


def test_a_squat_filmed_from_a_camera_that_then_moves_still_counts():
    # A genuine squat while the phone slides 40 px: knee bend, not hip position, carries it.
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=3)
    status = _drive_points(adapter, _SWEEP, lambda p: _moved(_real_squat(p), shift_y=p * 40.0))
    assert status["set"]["completed_reps"] == 1


# ---- Real cameras and real people: every squat counts (fsm.yaml) --------------------------------

def _squats(count: int, *, frame_ms: float, period_ms: float = 2000.0, rest: float = 0.0, peak: float = 0.9):
    """`count` back-to-back squats (a smooth down-and-up, no pause at the top), sampled every
    `frame_ms`, standing at depth `rest` between them."""
    from math import cos, pi
    frames, t = [], 0.0
    while t <= count * period_ms + 300:
        phase = (t % period_ms) / period_ms if t < count * period_ms else 0.0
        frames.append((rest + (peak - rest) * (1 - cos(2 * pi * phase)) / 2, t))
        t += frame_ms
    return frames


def test_a_slow_camera_still_counts_every_squat():
    # 7 frames a second: every gap is over the scoring frame gap (100 ms).
    status = _drive_points(build_squat_adapter(baseline=_baseline(), target_reps=5), _squats(3, frame_ms=150), _real_squat)
    assert status["set"]["completed_reps"] == 3


def test_hips_hidden_for_a_moment_at_the_bottom_still_counts():
    adapter = build_squat_adapter(baseline=_baseline(), target_reps=5)
    status = None
    for progress, timestamp in _squats(3, frame_ms=33):
        points = _real_squat(progress)
        if progress > 0.8:   # thighs cover the hips at the bottom: low-confidence hips
            points["left_hip"] = {**points["left_hip"], "v": 0.2}
        status = adapter.process(TrainingFrame(timestamp, points))
    assert status["set"]["completed_reps"] == 3


def test_standing_with_soft_knees_between_squats_still_counts():
    status = _drive_points(build_squat_adapter(baseline=_baseline(), target_reps=5), _squats(3, frame_ms=33, rest=0.2), _real_squat)
    assert status["set"]["completed_reps"] == 3


def test_quick_back_to_back_squats_each_count():
    status = _drive_points(build_squat_adapter(baseline=_baseline(), target_reps=5), _squats(4, frame_ms=33, period_ms=1300), _real_squat)
    assert status["set"]["completed_reps"] == 4


def _close_camera_squat(progress: float) -> dict:
    """A front-view squat close to the camera, as in a real session: the knees come toward the
    camera and drop almost as far as the hips (standing hip 750 / knee 1043 px; at 0.56 depth the
    hips are at 915 and the knees at 1160), and the knees and ankles leave the bottom of the image."""
    hip_y = 750.0 + progress * 293.0
    knee_y = 1043.0 + progress * 209.0
    knee_v = 0.9 if progress < 0.3 else 0.3
    return {
        "left_shoulder": {"x": 640.0, "y": 560.0, "v": 0.9}, "right_shoulder": {"x": 430.0, "y": 555.0, "v": 0.9},
        "left_hip": {"x": 600.0, "y": hip_y, "v": 0.9}, "right_hip": {"x": 470.0, "y": hip_y, "v": 0.9},
        "left_knee": {"x": 600.0 + progress * 150, "y": knee_y, "v": knee_v},
        "right_knee": {"x": 470.0 - progress * 150, "y": knee_y, "v": knee_v},
        "left_ankle": {"x": 590.0, "y": 1330.0, "v": 0.2}, "right_ankle": {"x": 480.0, "y": 1330.0, "v": 0.2},
    }


def test_squats_close_to_the_camera_count():
    # Knee/shin guards read this as straight legs and no rep ever counted.
    baseline = {name: {"x": p["x"], "y": p["y"]} for name, p in _close_camera_squat(0.0).items()}
    baseline["left_ankle"]["y"] = baseline["right_ankle"]["y"] = 1330.0
    adapter = build_squat_adapter(baseline=baseline, target_reps=5)
    status = _drive_points(adapter, _squats(3, frame_ms=66, peak=0.56), _close_camera_squat)
    assert status["set"]["completed_reps"] == 3
