"""Tests for the curl ROM rule (workouts/bicep_curl/rules/curl_rom.py) — the curl ROM brain.

Synthetic shoulder/elbow/wrist/hip landmarks place each wrist at a chosen height, so every
biomechanical claim is checked in isolation (no FSM, no rep counting): the per-arm ratio math
against the person's baseline hang, the leading-arm `progress`, the full-ROM gate, the shallow-vs-full
verdict a rep machine will use, body translation and baseline-scale invariance, shrug isolation,
the dual-arm limiting-side report, and the baseline/keypoint guards.

Geometry used throughout: shoulder at y=100, elbow 100px below it, the baseline wrist another 100px
below that — so the resting offset is 200/100 = 2.0 upper-arm lengths. With `target_offset` 0.0
(wrist level with the shoulder) the normalizing span is 2.0, i.e. progress 1.0 = the wrist has
risen 200px. The full-ROM gate is 0.75; the curl ROM signal has no hysteresis.
"""

from __future__ import annotations

from math import cos, radians, sin

import pytest

from backend.workouts.bicep_curl.rules.curl_rom import CurlRomReading, CurlRomRule

_SHOULDER_Y = 100.0
_UPPER_ARM = 100.0        # shoulder -> elbow, straight down
_REST_OFFSET = 2.0        # baseline wrist sits 200px (2 upper arms) below the shoulder
_TARGET_OFFSET = 0.0      # progress 1.0 = wrist level with the shoulder
_FULL_ROM_GATE = 0.75
_MIN_UPPER_ARM_PX = 30.0


def _arm(
    progress: float,
    cx: float,
    *,
    upper_arm: float = _UPPER_ARM,
    shoulder_y: float = _SHOULDER_Y,
):
    """Shoulder/elbow/wrist for one arm whose normalized curl progress is `progress`.

    The wrist is placed purely by height: it starts at the resting offset and rises by
    `progress` x the span. Horizontal placement is irrelevant to the signal, so the joints are
    stacked vertically."""
    offset = _REST_OFFSET - progress * (_REST_OFFSET - _TARGET_OFFSET)
    shoulder = (cx, shoulder_y)
    elbow = (cx, shoulder_y + upper_arm)
    wrist = (cx, shoulder_y + offset * upper_arm)
    return shoulder, elbow, wrist


def _kps(
    left_progress: float,
    right_progress: float,
    v: float = 0.9,
    upper_arm: float = _UPPER_ARM,
    shoulder_y: float = _SHOULDER_Y,
) -> dict:
    lsh, lel, lwr = _arm(left_progress, 100.0, upper_arm=upper_arm, shoulder_y=shoulder_y)
    rsh, rel, rwr = _arm(right_progress, 400.0, upper_arm=upper_arm, shoulder_y=shoulder_y)

    def p(t):
        return {"x": t[0], "y": t[1], "v": v}

    return {
        "left_shoulder": p(lsh), "left_elbow": p(lel), "left_wrist": p(lwr),
        "right_shoulder": p(rsh), "right_elbow": p(rel), "right_wrist": p(rwr),
        "left_hip": p((100.0, shoulder_y + 3.0 * upper_arm)),
        "right_hip": p((400.0, shoulder_y + 3.0 * upper_arm)),
    }


def _baseline(**overrides) -> dict:
    """The persisted baseline shape: geometry only, no visibility."""
    points = {
        name: {"x": point["x"], "y": point["y"]}
        for name, point in _kps(0.0, 0.0).items()
    }
    points.update(overrides)
    return points


def _transform(points: dict, *, rotation_deg: float, shift: tuple[float, float]) -> dict:
    angle = radians(rotation_deg)
    c, s = cos(angle), sin(angle)
    return {
        name: {
            **point,
            "x": point["x"] * c - point["y"] * s + shift[0],
            "y": point["x"] * s + point["y"] * c + shift[1],
        }
        for name, point in points.items()
    }


def _rule(gate: float = _FULL_ROM_GATE, baseline: dict | None = None) -> CurlRomRule:
    return CurlRomRule(
        _baseline() if baseline is None else baseline,
        _TARGET_OFFSET,
        gate,
        min_upper_arm_px=_MIN_UPPER_ARM_PX,
    )


# ── the curl measurement ─────────────────────────────────────────────────────────

def test_resting_hang_is_zero_progress():
    r = _rule().read(_kps(0.0, 0.0))
    assert r is not None
    assert r.left_ratio == pytest.approx(0.0, abs=1e-9)
    assert r.right_ratio == pytest.approx(0.0, abs=1e-9)
    assert r.progress == pytest.approx(0.0, abs=1e-9)


def test_wrist_at_target_is_progress_one():
    r = _rule().read(_kps(1.0, 1.0))
    assert r.progress == pytest.approx(1.0, abs=1e-9)
    # progress 1.0 means the wrist reached the configured target offset.
    assert r.left_offset == pytest.approx(_TARGET_OFFSET, abs=1e-9)


def test_halfway_is_progress_one_half():
    r = _rule().read(_kps(0.5, 0.5))
    assert r.progress == pytest.approx(0.5, abs=1e-9)


def test_wrist_below_the_resting_hang_is_negative_progress():
    r = _rule().read(_kps(-0.2, -0.2))
    assert r.progress == pytest.approx(-0.2, abs=1e-9)
    assert r.progress < 0.0


def test_progress_is_the_leading_arm_so_either_arm_counts():
    r = _rule().read(_kps(1.0, 0.4))
    assert r.left_ratio == pytest.approx(1.0, abs=1e-9)
    assert r.right_ratio == pytest.approx(0.4, abs=1e-9)
    assert r.progress == pytest.approx(r.left_ratio)
    assert r.weaker_side == "right"   # still named for coaching


def test_whole_body_vertical_translation_is_invariant():
    """Standing up taller or the camera tilting moves every joint together — the signal must not
    move. The baseline stays where it was captured; only the live frame translates."""
    rule = _rule()
    level = rule.read(_kps(0.6, 0.6))
    raised = rule.read(_kps(0.6, 0.6, shoulder_y=_SHOULDER_Y - 75.0))
    assert raised.progress == pytest.approx(level.progress, abs=1e-9)


def test_live_body_translation_is_invariant():
    rule = _rule()
    reference = rule.read(_kps(0.6, 0.6))
    moved = rule.read(_transform(_kps(0.6, 0.6), rotation_deg=0.0, shift=(300.0, -200.0)))
    assert moved.progress == pytest.approx(reference.progress, abs=1e-9)


def test_stepping_closer_after_setup_reads_the_same():
    # Setup needs the feet in view; people then step closer to curl. The live upper arm scales.
    rule = _rule()
    reference = rule.read(_kps(0.6, 0.6))
    closer = rule.read(_kps(0.6, 0.6, upper_arm=_UPPER_ARM * 1.9, shoulder_y=260.0))
    assert closer.progress == pytest.approx(reference.progress, abs=1e-9)


def test_hips_out_of_frame_still_read():
    frame = _kps(0.85, 0.85)
    del frame["left_hip"]
    frame["right_hip"]["v"] = 0.1
    reading = _rule().read(frame)
    assert reading.progress == pytest.approx(0.85, abs=1e-9)
    assert reading.full_rom is True


def test_a_shrug_that_carries_the_arm_does_not_change_rom():
    rule = _rule()
    clean = _kps(0.85, 0.85)
    shrug = _kps(0.85, 0.85)
    for joint in ("shoulder", "elbow", "wrist"):
        shrug[f"left_{joint}"]["y"] -= 16.0
    assert rule.read(shrug).progress == pytest.approx(rule.read(clean).progress, abs=1e-9)


def test_scale_invariance():
    """Moving nearer/further scales every span; a ratio of two spans is unchanged."""
    near = CurlRomRule(
        _baseline(), _TARGET_OFFSET, _FULL_ROM_GATE, min_upper_arm_px=_MIN_UPPER_ARM_PX
    ).read(_kps(0.6, 0.6))
    far_baseline = {
        name: {"x": point["x"], "y": point["y"]}
        for name, point in _kps(0.0, 0.0, upper_arm=250.0).items()
    }
    far = CurlRomRule(
        far_baseline, _TARGET_OFFSET, _FULL_ROM_GATE, min_upper_arm_px=_MIN_UPPER_ARM_PX
    ).read(_kps(0.6, 0.6, upper_arm=250.0))
    assert near.progress == pytest.approx(far.progress, abs=1e-9)


def test_arms_are_measured_independently():
    r = _rule().read(_kps(0.9, 0.2))
    assert r.left_ratio == pytest.approx(0.9, abs=1e-9)
    assert r.right_ratio == pytest.approx(0.2, abs=1e-9)


# ── the full-ROM gate / shallow verdict ──────────────────────────────────────────

def test_full_rom_when_the_leading_arm_reaches_gate():
    deep = _FULL_ROM_GATE + 0.05
    both = _rule().read(_kps(deep, deep))
    assert both.left_full and both.right_full
    assert both.full_rom is True
    assert both.shortfall is None
    # A single-arm curl: the other arm hangs. Full, with the resting arm named for coaching.
    single = _rule().read(_kps(deep, 0.0))
    assert single.left_full and not single.right_full
    assert single.full_rom is True
    assert single.weaker_side == "right"
    short = _rule().read(_kps(_FULL_ROM_GATE - 0.2, 0.0))
    assert short.full_rom is False
    assert short.shortfall is not None and short.shortfall > 0


def test_is_full_rom_gate_boundary():
    rule = _rule()
    assert rule.is_full_rom(_FULL_ROM_GATE) is True
    assert rule.is_full_rom(_FULL_ROM_GATE - 1e-6) is False
    assert rule.full_rom_gate == _FULL_ROM_GATE


# ── keypoint + construction guards ───────────────────────────────────────────────

def test_missing_shoulder_returns_none():
    frame = _kps(0.5, 0.5)
    del frame["right_shoulder"]
    assert _rule().read(frame) is None
    frame = _kps(0.5, 0.5)
    frame["left_shoulder"]["v"] = 0.1
    assert _rule().read(frame) is None


def test_one_hidden_arm_is_read_from_the_other():
    frame = _kps(0.2, 0.8)
    del frame["left_wrist"]
    r = _rule().read(frame)
    assert r.progress == pytest.approx(0.8, abs=1e-9)
    assert r.left_ratio == pytest.approx(r.right_ratio)
    frame = _kps(0.2, 0.8)
    frame["right_elbow"]["v"] = 0.1
    assert _rule().read(frame).progress == pytest.approx(0.2, abs=1e-9)


def test_no_measurable_arm_returns_none():
    frame = _kps(0.5, 0.5)
    del frame["left_wrist"]
    frame["right_elbow"]["v"] = 0.1
    assert _rule().read(frame) is None


def test_live_upper_arm_below_minimum_is_not_measured():
    """A collapsed shoulder→elbow span means the arm is turned away or the joints have merged;
    the normalization would divide by noise, so that arm is left out (both out: no reading)."""
    frame = _kps(0.5, 0.9)
    frame["left_elbow"]["y"] = frame["left_shoulder"]["y"] + 5.0
    assert _rule().read(frame).progress == pytest.approx(0.9, abs=1e-9)
    frame["right_elbow"]["y"] = frame["right_shoulder"]["y"] + 5.0
    assert _rule().read(frame) is None


def test_construction_rejects_unreadable_baseline():
    baseline = _baseline()
    del baseline["right_elbow"]
    with pytest.raises(ValueError, match="curl baseline"):
        _rule(baseline=baseline)
    with pytest.raises(ValueError, match="curl baseline"):
        _rule(baseline=_baseline(left_wrist={"x": 100.0, "y": float("nan")}))


def test_construction_rejects_short_baseline_upper_arm():
    baseline = _baseline(left_elbow={"x": 100.0, "y": _SHOULDER_Y + 10.0})
    with pytest.raises(ValueError, match="upper arm"):
        _rule(baseline=baseline)


def test_construction_rejects_baseline_hang_at_or_above_the_target():
    """A baseline captured with the wrists already raised leaves no span to normalize against."""
    baseline = _baseline(left_wrist={"x": 100.0, "y": _SHOULDER_Y})  # wrist at shoulder height
    with pytest.raises(ValueError, match="resting wrist offset"):
        _rule(baseline=baseline)


def test_construction_rejects_non_positive_gate():
    with pytest.raises(ValueError, match="gate"):
        _rule(gate=0.0)


def test_reading_is_frozen_dataclass():
    r = _rule().read(_kps(0.5, 0.5))
    assert isinstance(r, CurlRomReading)
    with pytest.raises(Exception):
        r.progress = 0.5  # type: ignore[misc]
