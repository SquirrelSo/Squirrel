"""Phase 7 High Knee timed replay, analyzer, labels and CLI tests."""

from __future__ import annotations

import json
from copy import deepcopy

import pytest

from backend.core.frame import TrainingFrame
from backend.tools import replay_session
from backend.training.debug_capture import TrainingDebugCapture
from backend.training.replay import (
    ReplayError,
    TimedReplayCapture,
    load_replay_capture,
    replay_capture,
    summarize_timed_lifts,
)
from backend.workouts.high_knee.adapter import build_high_knee_adapter
from backend.workouts.high_knee.replay_analysis import (
    analyze_high_knee_signals,
    build_high_knee_replay_adapter,
    load_lift_labels,
)


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


def _keypoints(left: float, right: float = 0.0) -> dict:
    points = deepcopy(_baseline())
    points["left_knee"]["y"] = 250.0 + 150.0 * (1.0 - left)
    points["right_knee"]["y"] = 250.0 + 150.0 * (1.0 - right)
    for point in points.values():
        point["v"] = 0.9
    return points


def _captured_set(tmp_path):
    set_dir = tmp_path / "set_1"
    baseline_dir = set_dir / "baseline_kp_data"
    baseline_dir.mkdir(parents=True)
    (baseline_dir / "high_knee_baseline.json").write_text(
        json.dumps(
            {"schema_version": 1, "keypoints": _baseline(), "quality": {}}
        ),
        encoding="utf-8",
    )
    adapter = build_high_knee_adapter(
        baseline=_baseline(), target_duration_ms=1_000
    )
    writer = TrainingDebugCapture(
        set_dir,
        exercise_id="high_knee",
        set_no=1,
        runtime_metadata=adapter.runtime_metadata(),
    )
    sequence = [
        (0.0, 0.0, 0),
        (0.35, 0.0, 100),
        (0.5, 0.0, 200),
        (0.8, 0.0, 300),
        (0.9, 0.0, 400),
        (0.8, 0.0, 500),
        (0.5, 0.0, 600),
        (0.05, 0.0, 700),
        (0.0, 0.0, 800),
        (0.0, 0.0, 900),
        (0.0, 0.0, 1_000),
    ]
    for left, right, timestamp in sequence:
        frame = TrainingFrame(float(timestamp), _keypoints(left, right))
        status = adapter.process(frame)
        writer.record(frame, status, adapter.debug_snapshot())
    return set_dir, sequence


def test_timed_capture_replays_with_exact_high_knee_parity(tmp_path):
    set_dir, sequence = _captured_set(tmp_path)
    capture = load_replay_capture(set_dir)
    assert isinstance(capture, TimedReplayCapture)

    parity = replay_capture(
        capture, adapter_factory=build_high_knee_replay_adapter
    )
    assert parity == {
        "ok": True,
        "checked_frames": len(sequence),
        "mismatch_count": 0,
        "mismatches": [],
    }
    assert summarize_timed_lifts(capture) == {
        "1": {
            "lift_id": 1,
            "side": "left",
            "classification": "full_rom",
            "peak_progress": 0.9,
            "started_t_ms": 100.0,
            "completed_t_ms": 700.0,
        }
    }


def test_analyzer_contains_required_frame_stream_and_set_summary(tmp_path):
    set_dir, sequence = _captured_set(tmp_path)
    capture = load_replay_capture(set_dir)
    report = analyze_high_knee_signals(capture, {})

    assert len(report["frames"]) == len(sequence)
    peak = report["frames"][4]
    assert peak["rom"]["left_progress_raw"] == pytest.approx(0.9)
    assert peak["fsm"]["left_phase"] == "top"
    completed = report["frames"][7]
    assert completed["lift_events"][0]["classification"] == "full_rom"
    assert completed["verdicts"] == ["full_rom"]
    assert "knee_drive_rom" in completed["rules"]
    assert completed["keypoint_availability"]["missing_required"] == []

    summary = report["set_summary"]
    assert summary["target_duration_ms"] == 1_000
    assert summary["actual_duration_ms"] == 1_000.0
    assert summary["attempted_lifts"] == 1
    assert summary["qualified_lifts"] == 1
    assert summary["left_lifts"] == 1 and summary["right_lifts"] == 0
    assert summary["rom_peak_distributions"]["left"]["max"] == 0.9
    assert summary["final_score"] == 100.0
    assert summary["reliability"] == "reliable"
    assert summary["tracking_coverage"]["any_available_ratio"] == 1.0


def test_reviewed_lift_labels_are_validated_and_attached(tmp_path):
    set_dir, _ = _captured_set(tmp_path)
    capture = load_replay_capture(set_dir)
    labels_path = set_dir / "lift_labels.json"
    labels_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "exercise": "high_knee",
                "set": 1,
                "lifts": {
                    "1": {
                        "category": "full",
                        "side": "left",
                        "confidence": "confirmed",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    labels = load_lift_labels(labels_path, capture)
    report = analyze_high_knee_signals(capture, labels)
    assert report["lifts"]["1"]["label"]["category"] == "full"

    document = json.loads(labels_path.read_text(encoding="utf-8"))
    document["lifts"]["1"]["side"] = "right"
    labels_path.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(ReplayError, match="side does not match"):
        load_lift_labels(labels_path, capture)


def test_cli_writes_timed_lifts_without_fake_rep_summary(tmp_path):
    set_dir, _ = _captured_set(tmp_path)
    output = tmp_path / "high_knee_replay.json"
    assert replay_session.main([str(set_dir), "--output", str(output)]) == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["exercise"] == "high_knee"
    assert report["parity"]["ok"] is True
    assert "reps" not in report
    assert report["lifts"]["1"]["classification"] == "full_rom"
    assert report["signals"]["set_summary"]["final_score"] == 100.0


def test_standing_interval_produces_no_phantom_lifts(tmp_path):
    adapter = build_high_knee_adapter(
        baseline=_baseline(), target_duration_ms=30_000
    )
    status = None
    for timestamp in range(0, 30_001, 100):
        status = adapter.process(
            TrainingFrame(float(timestamp), _keypoints(0.0, 0.0))
        )
    assert status is not None
    assert status["set"]["complete"] is True
    assert status["movement"]["detected_cycles"] == 0
    assert status["movement"]["counted_lifts"] == 0
    assert status["score"]["quality"] == "not_performed"
