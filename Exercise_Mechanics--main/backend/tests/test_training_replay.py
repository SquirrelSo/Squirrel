"""Deterministic capture replay: parity, generic rep outcomes, labels, and per-exercise signal
analysis (squat and curl) including the CLI's analyzer registry."""

from __future__ import annotations

import json

import pytest

from backend.core.frame import TrainingFrame
from backend.tools import replay_session
from backend.training.debug_capture import TrainingDebugCapture
from backend.training.replay import (
    ReplayError,
    load_replay_capture,
    replay_capture,
    summarize_reps,
)
from backend.workouts.bicep_curl.adapter import build_bicep_curl_adapter
from backend.workouts.bicep_curl.replay_analysis import (
    _fit_curl_height_slope,
    analyze_bicep_curl_signals,
    load_rep_labels as load_curl_rep_labels,
)
from backend.workouts.squat.adapter import build_squat_adapter
from backend.workouts.squat.replay_analysis import analyze_squat_signals, load_rep_labels

# Synthetic reps here are faster and shallower than the live counting policy accepts (conftest).
pytestmark = pytest.mark.usefixtures("legacy_rep_counting")


_FULL_REP = (
    (0.0, 0),
    (0.3, 100),
    (0.6, 200),
    (0.9, 300),
    (0.95, 400),
    (0.9, 500),
    (0.7, 600),
    (0.3, 700),
    (0.05, 800),
)


def _keypoints(progress: float) -> dict:
    return {
        "left_shoulder": {"x": 250.0, "y": 50.0, "v": 0.9},
        "right_shoulder": {"x": 150.0, "y": 50.0, "v": 0.9},
        "left_hip": {"x": 220.0, "y": 100.0 + progress * 100.0, "v": 0.9},
        "right_hip": {"x": 180.0, "y": 100.0 + progress * 100.0, "v": 0.9},
        "left_knee": {"x": 220.0, "y": 200.0, "v": 0.9},
        "right_knee": {"x": 180.0, "y": 200.0, "v": 0.9},
        "left_ankle": {"x": 250.0, "y": 300.0, "v": 0.9},
        "right_ankle": {"x": 150.0, "y": 300.0, "v": 0.9},
    }


def _captured_set(tmp_path):
    set_dir = tmp_path / "set_1"
    baseline = {
        name: {axis: value for axis, value in point.items() if axis != "v"}
        for name, point in _keypoints(0.0).items()
    }
    baseline_dir = set_dir / "baseline_kp_data"
    baseline_dir.mkdir(parents=True)
    (baseline_dir / "squat_baseline_keypoints.json").write_text(
        json.dumps({"schema_version": 1, "keypoints": baseline, "quality": {}}),
        encoding="utf-8",
    )
    adapter = build_squat_adapter(baseline=baseline, target_reps=1)
    capture = TrainingDebugCapture(
        set_dir,
        exercise_id="squat",
        set_no=1,
        runtime_metadata=adapter.runtime_metadata(),
    )
    for progress, timestamp in _FULL_REP:
        frame = TrainingFrame(float(timestamp), _keypoints(progress))
        status = adapter.process(frame)
        capture.record(frame, status, adapter.debug_snapshot())
    return set_dir


def test_real_adapter_capture_replays_with_exact_parity_and_signal_report(tmp_path):
    set_dir = _captured_set(tmp_path)
    capture = load_replay_capture(set_dir)

    parity = replay_capture(capture)
    signals = analyze_squat_signals(capture, {})

    assert parity["ok"] is True
    assert parity["checked_frames"] == len(_FULL_REP)
    assert parity["mismatches"] == []
    assert signals["classification_applied"] is False
    assert signals["per_rep"]["1"]["stored_form_score"]["final_score"] == 100.0
    assert len(signals["frames"]) == len(_FULL_REP)


def test_replay_reports_a_stored_output_tamper_without_changing_live_logic(tmp_path):
    set_dir = _captured_set(tmp_path)
    path = set_dir / "rep_1/rules/frame_1.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["tracking"]["available"] = False
    path.write_text(json.dumps(document), encoding="utf-8")

    parity = replay_capture(load_replay_capture(set_dir))

    assert parity["ok"] is False
    assert parity["mismatch_count"] == 1
    assert parity["mismatches"][0]["field"] == "tracking"


def test_replay_checks_the_separate_phase_and_final_score_artifact(tmp_path):
    set_dir = _captured_set(tmp_path)
    path = set_dir / "rep_1/form_score.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["final_score"] = 1.0
    path.write_text(json.dumps(document), encoding="utf-8")

    parity = replay_capture(load_replay_capture(set_dir))

    assert parity["ok"] is False
    assert parity["mismatch_count"] == 1
    assert parity["mismatches"][0]["field"] == "form_score"


def test_reviewed_rep_labels_are_preserved_as_evidence_not_classification(tmp_path):
    set_dir = _captured_set(tmp_path)
    labels_path = set_dir / "replay_labels.json"
    labels_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "exercise": "squat",
                "set": 1,
                "reps": {
                    "1": {
                        "category": "clean",
                        "side": "none",
                        "confidence": "confirmed",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    capture = load_replay_capture(set_dir)

    labels = load_rep_labels(labels_path, capture)
    signals = analyze_squat_signals(capture, labels)

    assert labels[1]["category"] == "clean"
    assert signals["measurement_only"] is True
    assert all(
        frame["left_inward_delta"] is None
        and frame["right_inward_delta"] is None
        and frame["bilateral_span_collapse"] is None
        and frame["lateral_torso_lean_deg"] is None
        for frame in signals["frames"]
        if frame["phase"] in {"setup", "reset"}
    )


# --------------------------------------------------------- any exercise: reps + registry

def _curl_keypoints(progress: float) -> dict:
    """Both wrists at the height giving `progress` against a rest offset of 2 upper arms."""
    offset = 2.0 - progress * 2.0
    result = {
        f"{side}_{joint}": {"x": x, "y": y, "v": 0.9}
        for side, x in (("left", 250.0), ("right", 150.0))
        for joint, y in (
            ("shoulder", 50.0),
            ("elbow", 150.0),
            ("wrist", 50.0 + offset * 100.0),
        )
    }
    result.update(
        {
            "left_hip": {"x": 250.0, "y": 350.0, "v": 0.9},
            "right_hip": {"x": 150.0, "y": 350.0, "v": 0.9},
            "left_ankle": {"x": 250.0, "y": 550.0, "v": 0.9},
            "right_ankle": {"x": 150.0, "y": 550.0, "v": 0.9},
        }
    )
    return result


def _captured_curl_set(tmp_path):
    set_dir = tmp_path / "set_1"
    baseline = {
        name: {axis: value for axis, value in point.items() if axis != "v"}
        for name, point in _curl_keypoints(0.0).items()
    }
    baseline_dir = set_dir / "baseline_kp_data"
    baseline_dir.mkdir(parents=True)
    (baseline_dir / "bicep_curl_baseline_keypoints.json").write_text(
        json.dumps({"schema_version": 1, "keypoints": baseline, "quality": {}}),
        encoding="utf-8",
    )
    adapter = build_bicep_curl_adapter(baseline=baseline, target_reps=1)
    capture = TrainingDebugCapture(
        set_dir,
        exercise_id="bicep_curl",
        set_no=1,
        runtime_metadata=adapter.runtime_metadata(),
    )
    for progress, timestamp in _FULL_REP:
        frame = TrainingFrame(float(timestamp), _curl_keypoints(progress))
        status = adapter.process(frame)
        capture.record(frame, status, adapter.debug_snapshot())
    return set_dir


def test_curl_height_slope_is_fitted_through_the_origin_and_refused_when_thin():
    """The measurement a new person's rig capture is tuned from.

    Forced through the origin because the correction is anchored at the person's own baseline: at
    rest the curl offset is zero and the expected rise must be zero too. A capture with too few
    movement frames returns None rather than a slope nobody should trust.
    """
    def records(count: int, slope: float) -> list[dict]:
        return [
            {
                "movement_phase": True,
                "shoulder_curl_offset": offset,
                "shoulder_raw_rise": slope * offset,
            }
            for offset in (i / count for i in range(1, count + 1))
        ]

    fitted = _fit_curl_height_slope(records(200, 0.04))
    assert fitted["slope"] == pytest.approx(0.04)
    assert fitted["frame_count"] == 200
    assert fitted["residual"]["stddev"] == pytest.approx(0.0, abs=1e-9)

    assert _fit_curl_height_slope(records(10, 0.04)) is None
    # Frames with no reading are skipped, not treated as zero.
    unreadable = [
        {"movement_phase": True, "shoulder_curl_offset": None, "shoulder_raw_rise": None}
    ] * 200
    assert _fit_curl_height_slope(unreadable) is None


def test_curl_capture_replays_with_parity_and_its_own_signal_report(tmp_path):
    """The regression this fixes: a curl capture used to reach the analyzer step and error out."""
    capture = load_replay_capture(_captured_curl_set(tmp_path))

    parity = replay_capture(capture)
    signals = analyze_bicep_curl_signals(capture, {})

    assert parity["ok"] is True
    assert parity["mismatches"] == []
    assert signals["classification_applied"] is False
    # The person-specific reference the ratios are normalized against.
    assert signals["baseline"]["rest_offset"] == {"left": 2.0, "right": 2.0}
    assert signals["baseline"]["elbow_flare_corridor"]["baseline_offset"] == {
        "left": 0.5,
        "right": 0.5,
    }
    assert signals["per_rep"]["1"]["movement"]["max_elbow_flare"][
        "statistics"
    ]["max"] == pytest.approx(0.0, abs=1e-6)
    # Shoulder elevation reports its reference and both ingredients of the curl-height correction,
    # so a new person's slope can be re-measured from the capture without re-deriving the geometry.
    shoulder = signals["baseline"]["shoulder_elevation"]
    assert set(shoulder) == {"height", "curl_height", "shoulder_width_px", "torso_length_px"}
    assert signals["protocol_constants"]["shoulder_elevation"]["curl_height_slope"] == 0.040
    for signal in (
        "max_shoulder_elevation",
        "shoulder_raw_rise",
        "shoulder_curl_offset",
    ):
        assert signal in signals["per_rep"]["1"]["movement"]
    # This capture is only a handful of frames long, and the fit refuses to report from that little
    # evidence rather than publishing a number a tuner might trust.
    assert signals["curl_height_slope_fit"] is None
    # The fixture curls with a RIGID girdle: raw rise is zero throughout, so once the expected
    # artifact is subtracted the corrected signal goes NEGATIVE. It must never read positive here —
    # a curl on its own can never be a shrug.
    assert signals["per_rep"]["1"]["movement"]["shoulder_raw_rise"][
        "statistics"
    ]["max"] == pytest.approx(0.0, abs=1e-6)
    assert signals["per_rep"]["1"]["movement"]["max_shoulder_elevation"][
        "statistics"
    ]["max"] <= 0.0
    assert signals["baseline"]["lateral_torso_lean"] == {
        "baseline_angle_deg": 0.0
    }
    assert signals["per_rep"]["1"]["movement"]["lateral_torso_lean_deg"][
        "statistics"
    ]["max"] == pytest.approx(0.0, abs=1e-6)
    assert signals["per_rep"]["1"]["peak"]["value"] == pytest.approx(0.95, abs=1e-6)
    assert len(signals["frames"]) == len(_FULL_REP)


def test_curl_analysis_measures_per_arm_asymmetry(tmp_path):
    """A single scalar hides a lagging arm; arm_gap is what makes it visible."""
    set_dir = tmp_path / "set_1"
    baseline = {
        name: {axis: value for axis, value in point.items() if axis != "v"}
        for name, point in _curl_keypoints(0.0).items()
    }
    (set_dir / "baseline_kp_data").mkdir(parents=True)
    (set_dir / "baseline_kp_data" / "bicep_curl_baseline_keypoints.json").write_text(
        json.dumps({"schema_version": 1, "keypoints": baseline, "quality": {}}),
        encoding="utf-8",
    )
    adapter = build_bicep_curl_adapter(baseline=baseline, target_reps=1)
    capture_writer = TrainingDebugCapture(
        set_dir, exercise_id="bicep_curl", set_no=1,
        runtime_metadata=adapter.runtime_metadata(),
    )
    for progress, timestamp in _FULL_REP:
        keypoints = _curl_keypoints(progress)
        # Hold the right arm 0.3 short of the left the whole way up and down.
        lagging = _curl_keypoints(max(0.0, progress - 0.3))
        for joint in ("shoulder", "elbow", "wrist"):
            keypoints[f"right_{joint}"]["y"] = lagging[f"right_{joint}"]["y"]
        frame = TrainingFrame(float(timestamp), keypoints)
        capture_writer.record(frame, adapter.process(frame), adapter.debug_snapshot())

    capture = load_replay_capture(set_dir)
    signals = analyze_bicep_curl_signals(capture, {})

    gap = signals["per_rep"]["1"]["movement"]["arm_gap"]["statistics"]
    assert gap["max"] == pytest.approx(0.3, abs=1e-6)
    assert signals["per_rep"]["1"]["weaker_side_at_peak"] == "right"


def test_rep_outcomes_are_summarized_without_a_per_exercise_analyzer(tmp_path):
    """Parity and rep verdicts come from generic machinery, so they work for any exercise."""
    for set_dir in (_captured_set(tmp_path / "squat"), _captured_curl_set(tmp_path / "curl")):
        reps = summarize_reps(load_replay_capture(set_dir))
        assert list(reps) == ["1"]
        assert reps["1"]["classification"] == "full_rom"
        assert reps["1"]["completed"] is True
        assert reps["1"]["discarded"] is False
        assert reps["1"]["score"] == 100.0
        assert reps["1"]["frame_count"] == len(_FULL_REP)


def test_cli_reports_parity_for_an_exercise_with_no_registered_analyzer(tmp_path, monkeypatch):
    set_dir = _captured_curl_set(tmp_path)
    output = tmp_path / "report.json"
    monkeypatch.delitem(replay_session.SIGNAL_ANALYZERS, "bicep_curl")

    exit_code = replay_session.main([str(set_dir), "--output", str(output)])

    assert exit_code == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["signals"] is None          # no analyzer: absent, not an error
    assert report["parity"]["ok"] is True     # parity still ran
    assert report["reps"]["1"]["score"] == 100.0


def test_cli_refuses_labels_it_cannot_validate(tmp_path, monkeypatch):
    set_dir = _captured_curl_set(tmp_path)
    labels = tmp_path / "labels.json"
    labels.write_text(json.dumps({"schema_version": 1}), encoding="utf-8")
    monkeypatch.delitem(replay_session.SIGNAL_ANALYZERS, "bicep_curl")

    with pytest.raises(SystemExit) as exit_info:
        replay_session.main([str(set_dir), "--labels", str(labels)])

    assert exit_info.value.code == 2


def test_cli_writes_both_analyzers_reports(tmp_path):
    for name, builder in (("squat", _captured_set), ("bicep_curl", _captured_curl_set)):
        output = tmp_path / f"{name}.json"
        assert replay_session.main([str(builder(tmp_path / name)), "--output", str(output)]) == 0
        report = json.loads(output.read_text(encoding="utf-8"))
        assert report["exercise"] == name
        assert report["signals"]["measurement_only"] is True
        assert report["reps"]["1"]["classification"] == "full_rom"


def test_curl_labels_use_curl_vocabulary(tmp_path):
    set_dir = _captured_curl_set(tmp_path)
    capture = load_replay_capture(set_dir)
    path = set_dir / "labels.json"

    def write(category: str) -> None:
        path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "exercise": "bicep_curl",
                    "set": 1,
                    "reps": {"1": {"category": category, "confidence": "confirmed"}},
                }
            ),
            encoding="utf-8",
        )

    write("shallow")
    assert load_curl_rep_labels(path, capture)[1]["category"] == "shallow"
    # Squat's vocabulary is not curl's; a knee label on a curl rep is a review mistake.
    write("knee_in")
    with pytest.raises(ReplayError, match="unsupported label category"):
        load_curl_rep_labels(path, capture)


# ------------------------------------------------- capture metadata + parity schema evolution

def test_capture_records_fsm_conditions_and_transitions(tmp_path):
    """Instrumentation is capture-only: it must reach disk without entering the socket status."""
    set_dir = _captured_curl_set(tmp_path)
    stored = json.loads((set_dir / "rep_1/rules/frame_2.json").read_text(encoding="utf-8"))

    assert set(stored["fsm"]["conditions"]) == {
        "movement_started",
        "full_rom_reached",
        "returned_to_rest",
        "above_min_rep_peak",
        "setup_armed",
    }
    assert stored["fsm"]["phase"] == stored["phase"]
    assert "arm_peaks" in stored["fsm"]


def test_capture_records_the_person_specific_signal_reference(tmp_path):
    """Configuration alone does not determine the signal; the baseline-derived reference does, so
    a capture that lost it could never be re-analyzed."""
    set_dir = _captured_curl_set(tmp_path)
    metadata = json.loads((set_dir / "rep_1/metadata.json").read_text(encoding="utf-8"))

    reference = metadata["signal_reference"]
    assert reference["rule_id"] == "curl_rom"
    assert reference["rest_offset"] == {"left": 2.0, "right": 2.0}
    assert reference["upper_arm_px"] == {"left": 100.0, "right": 100.0}
    # elbow_flare_corridor is live, so its baseline corridor IS recorded.
    assert reference["elbow_flare_corridor"]["baseline_offset"] == {"left": 0.5, "right": 0.5}
    # lateral_torso_lean is live, so its baseline reference IS recorded.
    assert reference["lateral_torso_lean"] == {"baseline_angle_deg": 0.0}


def test_per_arm_peaks_name_the_arm_that_curled_less(tmp_path):
    """The rep follows the leading arm; only the per-arm peaks say which arm curled less."""
    set_dir = tmp_path / "set_1"
    baseline = {
        name: {axis: value for axis, value in point.items() if axis != "v"}
        for name, point in _curl_keypoints(0.0).items()
    }
    (set_dir / "baseline_kp_data").mkdir(parents=True)
    (set_dir / "baseline_kp_data" / "b.json").write_text(
        json.dumps({"schema_version": 1, "keypoints": baseline, "quality": {}}), encoding="utf-8"
    )
    adapter = build_bicep_curl_adapter(baseline=baseline, target_reps=1)
    writer = TrainingDebugCapture(
        set_dir, exercise_id="bicep_curl", set_no=1,
        runtime_metadata=adapter.runtime_metadata(),
    )
    for progress, timestamp in _FULL_REP:
        keypoints = _curl_keypoints(progress)
        lagging = _curl_keypoints(max(0.0, progress - 0.25))
        for joint in ("shoulder", "elbow", "wrist"):
            keypoints[f"right_{joint}"]["y"] = lagging[f"right_{joint}"]["y"]
        frame = TrainingFrame(float(timestamp), keypoints)
        writer.record(frame, adapter.process(frame), adapter.debug_snapshot())

    score = json.loads((set_dir / "rep_1/form_score.json").read_text(encoding="utf-8"))
    assert score["last_attempt"]["classification"] == "full_rom"
    assert score["last_attempt"]["arm_peaks"] == {"left": 0.95, "right": 0.7}
    # ...and it surfaces in the generic rep summary the CLI prints.
    reps = summarize_reps(load_replay_capture(set_dir))
    assert reps["1"]["arm_peaks"] == {"left": 0.95, "right": 0.7}


def test_parity_ignores_fields_a_capture_never_recorded(tmp_path):
    """A capture taken before a diagnostic existed must still replay clean, or the parity baseline
    becomes a reason never to improve the instrumentation."""
    set_dir = _captured_curl_set(tmp_path)
    for path in (set_dir / "rep_1/rules").iterdir():
        document = json.loads(path.read_text(encoding="utf-8"))
        document.pop("fsm")                       # as if recorded by the older writer
        document["rom"].pop("weaker_side")        # a field added to an existing block
        path.write_text(json.dumps(document), encoding="utf-8")

    parity = replay_capture(load_replay_capture(set_dir))

    assert parity["ok"] is True
    assert parity["mismatch_count"] == 0


def test_parity_still_catches_a_changed_value_inside_a_recorded_block(tmp_path):
    """Tolerating additions must not tolerate a stored value that no longer reproduces."""
    set_dir = _captured_curl_set(tmp_path)
    path = set_dir / "rep_1/rules/frame_2.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["fsm"]["conditions"]["full_rom_reached"] = not document["fsm"]["conditions"][
        "full_rom_reached"
    ]
    path.write_text(json.dumps(document), encoding="utf-8")

    parity = replay_capture(load_replay_capture(set_dir))

    assert parity["ok"] is False
    assert parity["mismatches"][0]["field"] == "fsm"


def test_parity_still_catches_a_field_the_code_stopped_emitting(tmp_path):
    """The stored key is compared against actual.get(key), so a removal is a mismatch, not a skip."""
    set_dir = _captured_curl_set(tmp_path)
    path = set_dir / "rep_1/rules/frame_2.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["rom"]["invented_field"] = 1.0
    path.write_text(json.dumps(document), encoding="utf-8")

    parity = replay_capture(load_replay_capture(set_dir))

    assert parity["ok"] is False
    assert parity["mismatches"][0]["field"] == "rom"
