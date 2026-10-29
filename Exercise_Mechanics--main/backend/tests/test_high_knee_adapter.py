"""Phase 6 High Knee adapter integration tests."""

from __future__ import annotations

import json
from math import pi, sin
from copy import deepcopy
from pathlib import Path

import pytest

from backend.core.frame import TrainingFrame
from backend.engine.loader import validate_exercise_config
from backend.training.timed_contract import (
    LiftCycleEvent,
    TimedCoreStatus,
    TimedFrameEvents,
    TimedMovementCounters,
    TimedSetStatus,
)
from backend.training.debug_capture import TrainingDebugCapture
from backend.workouts.high_knee.adapter import (
    HighKneeAdapterConfigurationError,
    build_high_knee_adapter,
)

_PACKAGE = Path(__file__).resolve().parents[1] / "workouts" / "high_knee"
_CONFIG = validate_exercise_config("high_knee", _PACKAGE)


def _baseline() -> dict:
    return {
        "left_shoulder": {"x": 250.0, "y": 100.0},
        "right_shoulder": {"x": 150.0, "y": 100.0},
        "left_hip": {"x": 230.0, "y": 250.0},
        "right_hip": {"x": 170.0, "y": 250.0},
        "left_knee": {"x": 230.0, "y": 400.0},
        "right_knee": {"x": 170.0, "y": 400.0},
        "left_ankle": {"x": 230.0, "y": 550.0},
        "right_ankle": {"x": 170.0, "y": 550.0},
    }


def _keypoints(left: float, right: float | None = None) -> dict:
    right = left if right is None else right
    points = deepcopy(_baseline())
    points["left_knee"]["y"] = 250.0 + 150.0 * (1.0 - left)
    points["right_knee"]["y"] = 250.0 + 150.0 * (1.0 - right)
    for point in points.values():
        point["v"] = 0.9
    return points


def _frame(left: float, timestamp: float, right: float | None = None) -> TrainingFrame:
    return TrainingFrame(timestamp, _keypoints(left, right))


def _drift_frame(
    left: float,
    timestamp: float,
    right: float = 0.0,
    *,
    left_x: float = 230.0,
) -> TrainingFrame:
    points = _keypoints(left, right)
    points["left_knee"]["x"] = left_x
    return TrainingFrame(timestamp, points)


def _lean_frame(
    left: float,
    timestamp: float,
    right: float = 0.0,
    *,
    shoulder_shift_px: float = 0.0,
) -> TrainingFrame:
    points = _keypoints(left, right)
    points["left_shoulder"]["x"] += shoulder_shift_px
    points["right_shoulder"]["x"] += shoulder_shift_px
    return TrainingFrame(timestamp, points)


def _adapter(duration=5_000):
    return build_high_knee_adapter(
        baseline=_baseline(),
        target_duration_ms=duration,
        config=_CONFIG,
    )


def _penalties_config():
    """The shipped config with both placeholder penalty rules re-enabled.

    They ship disabled pending a fresh rig capture, but the corridor/lean scoring machinery is
    still exercised here so their behavior stays covered for when they are validated and turned on.
    """
    config = deepcopy(_CONFIG)
    config.contexts["live"]["knee_tracking_corridor"] = True
    config.contexts["live"]["lateral_torso_lean"] = True
    return config


def _adapter_with_penalties(duration=5_000):
    return build_high_knee_adapter(
        baseline=_baseline(),
        target_duration_ms=duration,
        config=_penalties_config(),
    )


def _drive(adapter, sequence):
    status = None
    for left, right, timestamp in sequence:
        status = adapter.process(_frame(left, timestamp, right))
    assert status is not None
    return status


_LEFT_FULL = [
    (0.0, 0.0, 0),
    (0.35, 0.0, 100),
    (0.5, 0.0, 200),
    (0.8, 0.0, 300),
    (0.9, 0.0, 400),
    (0.8, 0.0, 500),
    (0.5, 0.0, 600),
    (0.05, 0.0, 700),
]


def _assert_timed_core(status):
    set_status = TimedSetStatus(
        status["set"]["target_duration_ms"],
        status["set"]["elapsed_ms"],
        status["set"]["remaining_ms"],
        status["set"]["complete"],
    )
    movement = TimedMovementCounters(
        **{
            key: status["movement"][key]
            for key in TimedMovementCounters.__dataclass_fields__
        }
    )
    events = TimedFrameEvents(
        tuple(LiftCycleEvent(**event) for event in status["events"]["lift_cycles"]),
        status["events"]["set_completed"],
    )
    TimedCoreStatus(set_status, movement, events)


def test_one_full_lift_emits_one_timed_event_and_interval_score():
    status = _drive(_adapter(), _LEFT_FULL)
    _assert_timed_core(status)
    assert status["movement"]["detected_cycles"] == 1
    assert status["movement"]["counted_lifts"] == 1
    assert status["movement"]["full_lifts"] == 1
    assert status["movement"]["left_lifts"] == 1
    assert status["movement"]["right_lifts"] == 0
    assert status["events"]["lift_cycles"] == [
        {
            "lift_id": 1,
            "side": "left",
            "classification": "full_rom",
            "peak_progress": 0.9,
            "started_t_ms": 100.0,
            "completed_t_ms": 700.0,
        }
    ]
    assert status["score"]["score"] == 100.0
    assert status["score"]["quality"] == "reliable"
    assert status["last_lift_score"] == {
        "lift_id": 1,
        "side": "left",
        "classification": "full_rom",
        "score": 100.0,
        "rom_factor": 1.0,
        "form_factor": 1.0,
        "penalty": 0.0,
        "quality": "reliable",
    }


def test_simultaneous_completions_receive_stable_left_then_right_ids():
    sequence = [(left, left, timestamp) for left, _, timestamp in _LEFT_FULL]
    status = _drive(_adapter(), sequence)
    assert [
        (event["lift_id"], event["side"])
        for event in status["events"]["lift_cycles"]
    ] == [(1, "left"), (2, "right")]
    assert status["movement"]["counted_lifts"] == 2
    assert status["movement"]["left_lifts"] == 1
    assert status["movement"]["right_lifts"] == 1


def test_shallow_and_observed_invalid_cycles_have_separate_counters():
    shallow = [
        (0.0, 0.0, 0), (0.35, 0.0, 100), (0.5, 0.0, 200),
        (0.6, 0.0, 300), (0.5, 0.0, 400), (0.3, 0.0, 500),
        (0.05, 0.0, 600),
    ]
    shallow_status = _drive(_adapter(), shallow)
    assert shallow_status["movement"]["shallow_lifts"] == 1
    assert shallow_status["score"]["rom_factor"] == pytest.approx(0.6 / 0.9)
    assert shallow_status["last_lift_score"]["score"] == pytest.approx(66.7)
    assert shallow_status["cue"]["rule_id"] == "knee_drive_rom"

    invalid = [
        (0.0, 0.0, 0), (0.32, 0.0, 100), (0.36, 0.0, 200),
        (0.33, 0.0, 300), (0.28, 0.0, 400), (0.05, 0.0, 500),
    ]
    invalid_status = _drive(_adapter(), invalid)
    assert invalid_status["movement"]["invalid_lifts"] == 1
    assert invalid_status["movement"]["counted_lifts"] == 0
    assert invalid_status["score"]["quality"] == "not_performed"
    assert invalid_status["last_lift_score"] is None


def test_one_unavailable_knee_does_not_hide_the_other_signal_or_detector():
    adapter = _adapter()
    points = _keypoints(0.0, 0.5)
    del points["left_knee"]
    status = adapter.process(TrainingFrame(0.0, points))
    assert status["tracking"]["available"] is True
    assert status["tracking"]["left_available"] is False
    assert status["tracking"]["right_available"] is True
    assert status["rom"]["left_progress_raw"] is None
    assert status["rom"]["right_progress_raw"] == pytest.approx(0.5)


def test_alternation_and_cadence_are_metrics_and_do_not_change_score():
    adapter = _adapter()
    _drive(adapter, _LEFT_FULL)
    for timestamp in (800, 900):
        adapter.process(_frame(0.0, timestamp, 0.0))
    right_full = [
        (0.0, 0.2, 1000), (0.0, 0.5, 1100), (0.0, 0.8, 1200),
        (0.0, 0.9, 1300), (0.0, 0.8, 1400), (0.0, 0.5, 1500),
        (0.0, 0.05, 1600),
    ]
    status = _drive(adapter, right_full)
    assert status["movement"]["alternation_breaks"] == 0
    assert status["movement"]["current_cadence_spm"] == pytest.approx(66.7)
    assert status["movement"]["average_cadence_spm"] == pytest.approx(75.0)
    assert status["score"]["score"] == 100.0


def test_timer_completes_once_and_later_frames_do_not_mutate_movement():
    adapter = _adapter(duration=1_000)
    first = adapter.process(_frame(0.0, 100.0, 0.0))
    assert first["set"]["elapsed_ms"] == 0.0
    complete = adapter.process(_frame(0.0, 1100.0, 0.0))
    assert complete["set"]["complete"] is True
    assert complete["events"]["set_completed"] is True

    later = adapter.process(_frame(1.0, 2000.0, 1.0))
    assert later["set"] == complete["set"]
    assert later["movement"] == complete["movement"]
    assert later["events"] == {"lift_cycles": [], "set_completed": False}


def test_runtime_metadata_and_debug_snapshot_preserve_both_fsm_sides():
    adapter = _adapter()
    adapter.process(_frame(0.4, 0.0, 0.2))
    metadata = adapter.runtime_metadata()
    assert metadata["fsm"]["movement_type"] == "time"
    # Shipped default: both penalty rules live for validation, plus ROM and the asymmetry monitor.
    assert metadata["active_rule_ids"] == [
        "knee_tracking_corridor",
        "lateral_torso_lean",
        "knee_drive_rom",
        "left_right_asymmetry",
    ]
    assert metadata["signal_reference"] == {
        "rule_id": "knee_drive_rom",
        "left_baseline_gap_px": 150.0,
        "right_baseline_gap_px": 150.0,
    }
    debug = adapter.debug_snapshot()
    assert set(debug["fsm"]) == {"left", "right"}
    assert debug["rules"]["knee_drive_rom"]["active"] is True
    assert debug["rules"]["knee_tracking_corridor"]["active"] is True
    assert debug["rules"]["lateral_torso_lean"]["active"] is True
    assert debug["rules"]["left_right_asymmetry"]["active"] is True


def test_active_knee_tracking_fault_emits_issue_cue_and_reduces_score():
    adapter = _adapter_with_penalties()
    adapter.process(_drift_frame(0.0, 0.0))
    active_status = None
    for progress, timestamp in (
        (0.2, 100.0),
        (0.5, 200.0),
        (0.8, 300.0),
        (0.9, 400.0),
        (0.8, 500.0),
        (0.5, 600.0),
    ):
        active_status = adapter.process(
            _drift_frame(progress, timestamp, left_x=264.0)
        )
    assert active_status is not None
    assert active_status["issues"] == [
        {
            "id": "knee_tracking_corridor",
            "label": "Knee tracking",
            "tier": "high",
            "side": "left",
            "state": "not_ok",
            "skeleton_color": "red",
        }
    ]
    assert active_status["cue"]["rule_id"] == "knee_tracking_corridor"

    final = adapter.process(_drift_frame(0.05, 700.0))
    assert final["movement"]["full_lifts"] == 1
    assert final["score"]["quality"] == "reliable"
    assert final["score"]["score"] < 100.0
    assert final["score_coverage"]["available_penalty_rule_ids"] == [
        "knee_tracking_corridor",
        "lateral_torso_lean",
    ]


def test_knee_tracking_cue_requires_300ms_and_clears_without_amber_fallback():
    adapter = _adapter_with_penalties()
    adapter.process(_drift_frame(0.0, 0.0))

    for progress, timestamp in ((0.35, 100.0), (0.5, 200.0), (0.8, 300.0)):
        transient = adapter.process(
            _drift_frame(progress, timestamp, left_x=264.0)
        )
        assert transient["issues"] == []
        assert transient["cue"] is None

    confirmed = adapter.process(_drift_frame(0.9, 400.0, left_x=264.0))
    assert confirmed["issues"] == [
        {
            "id": "knee_tracking_corridor",
            "label": "Knee tracking",
            "tier": "high",
            "side": "left",
            "state": "not_ok",
            "skeleton_color": "red",
        }
    ]
    assert confirmed["cue"]["rule_id"] == "knee_tracking_corridor"

    recovered = adapter.process(_drift_frame(0.8, 500.0, left_x=230.0))
    assert recovered["issues"] == []
    assert recovered["cue"] is None


def test_knee_drift_while_standing_is_phase_gated_out():
    status = _adapter_with_penalties().process(_drift_frame(0.0, 0.0, left_x=270.0))
    assert status["issues"] == []
    assert status["cue"] is None
    assert status["score"]["quality"] == "not_performed"


def test_active_lateral_lean_fault_emits_rank_two_issue_and_reduces_score():
    adapter = _adapter_with_penalties()
    adapter.process(_lean_frame(0.0, 0.0))
    active_status = None
    for progress, timestamp in (
        (0.2, 100.0),
        (0.5, 200.0),
        (0.8, 300.0),
        (0.9, 400.0),
        (0.8, 500.0),
        (0.5, 600.0),
    ):
        active_status = adapter.process(
            _lean_frame(progress, timestamp, shoulder_shift_px=25.0)
        )
    assert active_status is not None
    assert active_status["issues"] == [
        {
            "id": "lateral_torso_lean",
            "label": "Lateral torso lean",
            "tier": "high",
            "side": "left",
            "state": "not_ok",
            "skeleton_color": "red",
        }
    ]
    assert active_status["cue"]["rule_id"] == "lateral_torso_lean"

    final = adapter.process(_lean_frame(0.05, 700.0))
    assert final["movement"]["full_lifts"] == 1
    assert final["score"]["quality"] == "reliable"
    assert final["score"]["score"] < 100.0


def test_clean_lift_restores_live_score_without_erasing_cumulative_set_penalty():
    adapter = _adapter_with_penalties()
    adapter.process(_lean_frame(0.0, 0.0))
    for progress, timestamp in (
        (0.2, 100.0),
        (0.5, 200.0),
        (0.8, 300.0),
        (0.9, 400.0),
        (0.8, 500.0),
        (0.5, 600.0),
    ):
        adapter.process(
            _lean_frame(progress, timestamp, shoulder_shift_px=25.0)
        )
    faulty = adapter.process(_lean_frame(0.05, 700.0))
    assert faulty["last_lift_score"]["score"] == 70.0
    assert faulty["score"]["score"] == 70.0

    adapter.process(_lean_frame(0.0, 800.0))
    adapter.process(_lean_frame(0.0, 900.0))
    clean = None
    for progress, timestamp in (
        (0.2, 1000.0),
        (0.5, 1100.0),
        (0.8, 1200.0),
        (0.9, 1300.0),
        (0.8, 1400.0),
        (0.5, 1500.0),
        (0.05, 1600.0),
    ):
        clean = adapter.process(_lean_frame(0.0, timestamp, right=progress))

    assert clean is not None
    assert clean["last_lift_score"] == {
        "lift_id": 2,
        "side": "right",
        "classification": "full_rom",
        "score": 100.0,
        "rom_factor": 1.0,
        "form_factor": 1.0,
        "penalty": 0.0,
        "quality": "reliable",
    }
    assert clean["score"]["score"] == 85.0
    assert clean["score"]["form_factor"] == 0.85


def test_lateral_lean_while_standing_is_phase_gated_out():
    status = _adapter_with_penalties().process(
        _lean_frame(0.0, 0.0, shoulder_shift_px=30.0)
    )
    assert status["issues"] == []
    assert status["cue"] is None
    assert status["score"]["quality"] == "not_performed"


def test_asymmetry_monitor_uses_completed_lift_peaks_without_changing_score_or_cues():
    adapter = _adapter(duration=10_000)
    timestamp = 0.0
    status = adapter.process(_frame(0.0, timestamp, 0.0))
    for side, peak in (
        ("left", 0.95),
        ("right", 0.60),
        ("left", 0.96),
        ("right", 0.62),
        ("left", 0.94),
        ("right", 0.61),
    ):
        for progress in (0.2, 0.5, peak, peak - 0.1, 0.5, 0.05, 0.0, 0.0):
            timestamp += 100.0
            left, right = (progress, 0.0) if side == "left" else (0.0, progress)
            status = adapter.process(_frame(left, timestamp, right))

    monitor = status["monitors"]["left_right_asymmetry"]
    assert monitor["status"] == "asymmetric"
    assert monitor["left_samples"] == monitor["right_samples"] == 3
    assert monitor["left_median_travel"] == pytest.approx(0.95)
    assert monitor["right_median_travel"] == pytest.approx(0.61)
    assert monitor["lower_side"] == "right"
    assert status["score"]["score"] == pytest.approx(83.9)
    # Both penalty rules are live; clean marching produces no fault, so the score stays pure ROM
    # and the shallow cue still wins.
    assert status["score_coverage"]["penalty_rule_ids"] == [
        "knee_tracking_corridor",
        "lateral_torso_lean",
    ]
    assert status["issues"] == []
    assert status["cue"]["rule_id"] == "knee_drive_rom"


def test_generic_timed_capture_accepts_adapter_status_and_writes_lift_event(tmp_path):
    adapter = _adapter()
    capture = TrainingDebugCapture(
        tmp_path / "set_1",
        exercise_id="high_knee",
        set_no=1,
        runtime_metadata=adapter.runtime_metadata(),
    )
    for left, right, timestamp in _LEFT_FULL:
        frame = _frame(left, timestamp, right)
        status = adapter.process(frame)
        capture.record(frame, status, adapter.debug_snapshot())

    event = json.loads(
        (tmp_path / "set_1/lift_events/lift_1.json").read_text(encoding="utf-8")
    )
    assert event["event"]["side"] == "left"
    assert event["event"]["classification"] == "full_rom"
    summary = json.loads(
        (tmp_path / "set_1/set_summary.json").read_text(encoding="utf-8")
    )
    assert summary["movement_type"] == "time"
    assert summary["counted_lifts"] == 1
    assert summary["monitors"]["left_right_asymmetry"]["status"] == "insufficient"


def test_builder_rejects_bad_baseline_and_duration():
    with pytest.raises(HighKneeAdapterConfigurationError, match="baseline"):
        build_high_knee_adapter(
            baseline={}, target_duration_ms=1_000, config=_CONFIG
        )
    with pytest.raises(HighKneeAdapterConfigurationError, match="positive integer"):
        build_high_knee_adapter(
            baseline=_baseline(), target_duration_ms=0, config=_CONFIG
        )


def test_older_capture_config_without_the_monitor_remains_replayable():
    legacy = deepcopy(_CONFIG)
    legacy.contexts["live"]["left_right_asymmetry"] = False
    legacy.templates["left_right_asymmetry"]["tuning_status"] = "placeholder"
    legacy.templates["left_right_asymmetry"].pop("min_lifts_per_side")
    legacy.templates["left_right_asymmetry"].pop("max_travel_gap")

    adapter = build_high_knee_adapter(
        baseline=_baseline(), target_duration_ms=1_000, config=legacy
    )
    status = adapter.process(_frame(0.0, 0.0, 0.0))
    assert "left_right_asymmetry" not in adapter.active_rule_ids
    assert status["monitors"] == {}


def _alternating_high_knees(seconds, *, frame_ms, period_ms=700.0, rest=0.0, peak=0.9):
    """Each leg lifts once per `period_ms`, half a period after the other."""
    from math import cos, pi

    def wave(t):
        return rest + (peak - rest) * (1 - cos(2 * pi * (t % period_ms) / period_ms)) / 2 if 0 <= t < seconds * 1000 else rest

    frames, t = [], 0.0
    while t <= seconds * 1000 + period_ms:
        frames.append((wave(t), wave(t - period_ms / 2), t))
        t += frame_ms
    return frames


def _count_lifts(sequence):
    status = _drive(_adapter(duration=60_000), sequence)
    return status["movement"]["counted_lifts"]


def test_a_slow_camera_counts_every_lift():
    # 7 s at one lift per leg every 0.7 s: 10 lifts per leg.
    assert _count_lifts(_alternating_high_knees(7, frame_ms=100)) == 20


def test_feet_that_barely_settle_between_lifts_still_count():
    assert _count_lifts(_alternating_high_knees(7, frame_ms=33, rest=0.12)) == 20


def _scaled(points: dict, scale: float, *, drop_shoulders: bool = False) -> dict:
    """The same body as the camera sees it `scale` times as big (closer or further away)."""
    out = {name: {**p, "x": 200.0 + (p["x"] - 200.0) * scale, "y": 550.0 + (p["y"] - 550.0) * scale} for name, p in points.items()}
    if drop_shoulders:
        for name in ("left_shoulder", "right_shoulder"):
            out[name]["v"] = 0.1
    return out


@pytest.mark.parametrize(
    ("scale", "drop_shoulders"),
    [(0.75, False), (1.3, False), (1.0, True)],
    ids=["further-than-setup", "closer-than-setup", "shoulders-out-of-frame"],
)
def test_high_knees_count_away_from_the_setup_spot_or_with_shoulders_hidden(scale, drop_shoulders):
    adapter = _adapter(duration=60_000)
    status = None
    for left, right, t in _alternating_high_knees(5, frame_ms=33):
        points = _scaled(_keypoints(left, right), scale, drop_shoulders=drop_shoulders)
        status = adapter.process(TrainingFrame(t, points))
    assert status["movement"]["counted_lifts"] == 14


def test_a_slow_march_is_coached_and_not_counted():
    """Field test: a slow left-right march counted as high knees."""
    adapter = build_high_knee_adapter(baseline=_baseline(), target_duration_ms=30_000)
    statuses, t = [], 0
    for side in ("left", "right", "left"):
        for step in range(0, 1600, 50):   # a 1.6 s lift: a march
            p = 0.8 * sin(pi * step / 1600)
            statuses.append(adapter.process(_frame(p, t, 0.0) if side == "left" else _frame(0.0, t, p)))
            t += 50
        for _ in range(6):
            statuses.append(adapter.process(_frame(0.0, t, 0.0)))
            t += 50
    final = statuses[-1]
    assert final["movement"]["counted_lifts"] == 0
    assert final["movement"]["invalid_lifts"] >= 3
    assert any(s["cue"] and s["cue"]["rule_id"] == "tempo" for s in statuses)
