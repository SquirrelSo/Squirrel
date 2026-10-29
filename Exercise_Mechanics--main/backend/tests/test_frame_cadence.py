"""Frame-cadence-aware tracking-gap boundary: slow phone cameras must not read as lost tracking."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

from backend.engine.cadence import FrameGapBoundary
from backend.engine.loader import (
    ConfigurationError,
    fsm_params,
    load_exercise_config,
    validate_exercise_config,
)
from backend.engine.timeline import RepTimeline, TimelineFrame
from backend.workouts.squat.fsm import SquatFSM

_GATE = 0.85
_CADENCE = {"tolerance_frames": 3, "max_gap_ms": 400}


def _squat_fsm(**overrides) -> SquatFSM:
    params = {**fsm_params("squat"), **overrides}
    return SquatFSM(reached_gate=lambda value: value >= _GATE, **params)


def _frames(progress: list[float | None], interval_ms: float, start_ms: float = 0.0):
    return [(value, start_ms + index * interval_ms) for index, value in enumerate(progress)]


# A slow (~9 fps, 110 ms) camera: a few resting frames establish the cadence, then one real rep in
# which a single frame drops out mid-descent (a normal event on a low-light, compressed stream).
_REST = [0.0] * 8
_REP_WITH_DROPOUT = [0.3, None, 0.9, 0.95, 0.9, 0.6, 0.3, 0.05] + [0.0] * 8


def test_live_squat_configuration_enables_cadence_boundary():
    assert fsm_params("squat")["frame_cadence"] == _CADENCE
    for slug in ("squat", "bicep_curl", "high_knee"):
        assert load_exercise_config(slug).scoring["frame_cadence"] == _CADENCE


def test_boundary_matches_configured_limit_at_thirty_fps():
    boundary = FrameGapBoundary(100, _CADENCE)
    for index in range(40):
        boundary.observe(index * 33.3)
    assert boundary.limit_ms == 100


def test_boundary_scales_with_slow_cadence_and_is_capped():
    slow = FrameGapBoundary(100, _CADENCE)
    for index in range(40):
        slow.observe(index * 110.0)
    assert slow.limit_ms == pytest.approx(330.0)

    very_slow = FrameGapBoundary(100, _CADENCE)
    for index in range(40):
        very_slow.observe(index * 250.0)
    assert very_slow.limit_ms == 400


def test_boundary_without_cadence_config_is_the_fixed_limit():
    boundary = FrameGapBoundary(100)
    for index in range(40):
        boundary.observe(index * 200.0)
    assert boundary.limit_ms == 100
    assert not boundary.adaptive


def test_single_stall_does_not_widen_its_own_boundary():
    boundary = FrameGapBoundary(100, _CADENCE)
    for index in range(10):
        boundary.observe(index * 33.0)
    # The stall is judged against the cadence seen before it.
    assert boundary.observe(9 * 33.0 + 2000.0) == 100


def test_slow_camera_rep_with_one_dropped_frame_is_counted():
    fsm = _squat_fsm()
    state = None
    for value, t_ms in _frames(_REST + _REP_WITH_DROPOUT, 110.0):
        state = fsm.update(value, t_ms)
    assert state is not None
    assert state.attempt_count == 1
    assert state.qualified_count == 1
    assert state.full_rom_count == 1


def test_same_rep_is_discarded_with_the_legacy_fixed_boundary():
    """Documents the low-end-phone failure the cadence boundary fixes. The live squat also tolerates
    a fixed 1 s gap (fsm.yaml max_tracking_gap_ms), so both protections are switched off here."""
    fsm = _squat_fsm(frame_cadence=None, max_tracking_gap_ms=None)
    state = None
    for value, t_ms in _frames(_REST + _REP_WITH_DROPOUT, 110.0):
        state = fsm.update(value, t_ms)
    assert state is not None
    assert state.qualified_count == 0


def test_long_gap_still_discards_the_partial_rep_on_a_slow_camera():
    fsm = _squat_fsm()
    frames = _frames(_REST + [0.3, 0.6, 0.9], 110.0)
    for value, t_ms in frames:
        fsm.update(value, t_ms)
    # 1.5 s without tracking: beyond both the cadence boundary (max_gap_ms) and the squat's fixed
    # max_tracking_gap_ms (1 s), so the larger of the two still counts it as lost tracking.
    resume_at = frames[-1][1] + 1500.0
    for index, value in enumerate([0.95, 0.9, 0.6, 0.3, 0.05] + [0.0] * 8):
        state = fsm.update(value, resume_at + index * 110.0)
    assert state.qualified_count == 0


def test_timeline_credits_evidence_at_slow_cadence():
    def run(frame_cadence):
        timeline = RepTimeline({"depth": ["descent"]}, max_frame_delta_ms=100, frame_cadence=frame_cadence)
        gaps = 0
        for index in range(30):
            update = timeline.push(
                TimelineFrame(t_ms=index * 110.0, phase="descent", tracking=True, rule_states={"depth": False})
            )
            gaps += int(update.tracking_gap)
        return gaps, timeline.snapshot()

    fixed_gaps, fixed = run(None)
    adaptive_gaps, adaptive = run(_CADENCE)
    assert fixed_gaps == 29
    assert adaptive_gaps < fixed_gaps
    assert adaptive.rules["depth"].active_ms > fixed.rules["depth"].active_ms


_SQUAT_DIR = Path(__file__).resolve().parents[1] / "workouts" / "squat"


@pytest.mark.parametrize(
    "cadence",
    [
        {"tolerance_frames": 0, "max_gap_ms": 400},
        {"tolerance_frames": 3, "max_gap_ms": 50},
        {"tolerance_frames": 3},
        {"tolerance_frames": 3, "max_gap_ms": 400, "extra": 1},
        "fast",
    ],
)
def test_invalid_cadence_configuration_is_rejected(tmp_path: Path, cadence):
    target = tmp_path / "squat"
    shutil.copytree(_SQUAT_DIR / "configs", target / "configs")
    path = target / "configs" / "templates.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["scoring"]["frame_cadence"] = cadence
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    with pytest.raises(ConfigurationError, match="frame_cadence"):
        validate_exercise_config("squat", target)


def test_configuration_without_cadence_remains_valid(tmp_path: Path):
    target = tmp_path / "squat"
    shutil.copytree(_SQUAT_DIR / "configs", target / "configs")
    path = target / "configs" / "templates.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["scoring"].pop("frame_cadence")
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    validate_exercise_config("squat", target)
