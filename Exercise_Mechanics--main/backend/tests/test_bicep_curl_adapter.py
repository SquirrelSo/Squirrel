"""Bicep curl adapter integration over live rules, FSM, timeline, scorer and cues.

Both wrists are placed at the height that yields a target normalized `progress` against the
baseline hang, so rep sequences read like the squat adapter's. Elbow flare and shoulder elevation
follow the same penalty-rule path used by squat.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from math import cos, radians, sin
from pathlib import Path

import pytest

from backend.core.frame import TrainingFrame
from backend.engine.loader import validate_exercise_config
from backend.workouts.bicep_curl.adapter import (
    BicepCurlAdapterConfigurationError,
    build_bicep_curl_adapter,
)

# Synthetic reps here are faster and shallower than the live counting policy accepts (conftest).
pytestmark = pytest.mark.usefixtures("legacy_rep_counting")

_SHOULDER_Y = 100.0
_UPPER_ARM = 100.0
_REST_OFFSET = 2.0  # baseline wrist hangs two upper-arm lengths below the shoulder
_CONFIG = validate_exercise_config(
    "bicep_curl", Path(__file__).resolve().parents[1] / "workouts" / "bicep_curl"
)
_GATE = _CONFIG.templates["curl_rom"]["full_rom_gate"]
_TARGET_OFFSET = _CONFIG.templates["curl_rom"]["target_offset"]

# Shoulder-elevation fixtures are expressed in the CONFIGURED bands rather than raw pixels: the
# thresholds are tuned from rig data and will move again, and a hardcoded pixel rise silently
# changes meaning when they do. The fixture baseline is 300px wide, and the signal is a rise
# normalized by that captured baseline shoulder width, so pixels = band x 300.
_FIXTURE_SHOULDER_WIDTH_PX = 300.0
_ELBOW_BANDS = _CONFIG.templates["elbow_flare_corridor"]["policy"]["ranges"]
_ELBOW_SAFE_CEILING = _ELBOW_BANDS[0]["range"]["lte"]
_ELBOW_FAULT_FLOOR = _ELBOW_BANDS[1]["range"]["lte"]


def _rise_px(normalized: float) -> float:
    return normalized * _FIXTURE_SHOULDER_WIDTH_PX


# Mid-warning and comfortably past the fault boundary.
_WARNING_FLARE_PX = _rise_px((_ELBOW_SAFE_CEILING + _ELBOW_FAULT_FLOOR) / 2)
_FAULT_FLARE_PX = _rise_px(_ELBOW_FAULT_FLOOR * 1.5)


def _arm(progress: float, cx: float):
    offset = _REST_OFFSET - progress * (_REST_OFFSET - _TARGET_OFFSET)
    return (
        (cx, _SHOULDER_Y),
        (cx, _SHOULDER_Y + _UPPER_ARM),
        (cx, _SHOULDER_Y + offset * _UPPER_ARM),
    )


def _keypoints(
    progress: float,
    right_progress: float | None = None,
    v: float = 0.9,
    *,
    left_elbow_flare: float = 0.0,
    right_elbow_flare: float = 0.0,
    torso_lean_deg: float = 0.0,
) -> dict:
    lsh, lel, lwr = _arm(progress, 100.0)
    rp = progress if right_progress is None else right_progress
    rsh, rel, rwr = _arm(rp, 400.0)

    def p(t):
        return {"x": t[0], "y": t[1], "v": v}

    result = {
        "left_shoulder": p(lsh), "left_elbow": p(lel), "left_wrist": p(lwr),
        "right_shoulder": p(rsh), "right_elbow": p(rel), "right_wrist": p(rwr),
        "left_hip": p((100.0, 400.0)), "right_hip": p((400.0, 400.0)),
        "left_ankle": p((100.0, 600.0)), "right_ankle": p((400.0, 600.0)),
    }
    # The fixture's left side is at the smaller x coordinate: outward is -x on the left and +x on
    # the right. ROM is intentionally independent of elbow x.
    result["left_elbow"]["x"] -= left_elbow_flare
    result["right_elbow"]["x"] += right_elbow_flare
    # Rotate the complete upper body around the hip midpoint. This produces a true rigid lateral
    # torso lean while preserving ROM, shoulder-girdle shape and elbow-corridor geometry.
    angle = -radians(torso_lean_deg)
    c, s = cos(angle), sin(angle)
    for side in ("left", "right"):
        for joint in ("shoulder", "elbow", "wrist"):
            point = result[f"{side}_{joint}"]
            dx, dy = point["x"] - 250.0, point["y"] - 400.0
            point["x"] = 250.0 + dx * c - dy * s
            point["y"] = 400.0 + dx * s + dy * c
    return result


_BASELINE = {
    name: {"x": point["x"], "y": point["y"]}
    for name, point in _keypoints(0.0).items()
}


def _frame(
    progress: float,
    timestamp: float,
    right_progress: float | None = None,
    **keypoint_options,
) -> TrainingFrame:
    return TrainingFrame(
        timestamp,
        _keypoints(progress, right_progress, **keypoint_options),
    )


# Sequences in normalized progress space (same shape as the squat adapter fixtures).
_FULL = [(0.0, 0), (0.3, 100), (0.6, 200), (0.9, 300), (0.95, 400), (0.9, 500), (0.7, 600), (0.3, 700), (0.05, 800)]
_SHALLOW = [(0.0, 0), (0.3, 100), (0.6, 200), (0.7, 300), (0.5, 400), (0.3, 500), (0.05, 600)]
_INVALID = [(0.0, 0), (0.28, 100), (0.35, 200), (0.3, 300), (0.27, 400), (0.05, 500)]


def _adapter(target_reps: int = 3, *, enabled_rules: tuple[str, ...] = ()):
    contexts = deepcopy(_CONFIG.contexts)
    for rule_id in enabled_rules:
        contexts["live"][rule_id] = True
    config = replace(_CONFIG, contexts=contexts)
    return build_bicep_curl_adapter(
        baseline=_BASELINE, target_reps=target_reps, config=config
    )


def _drive(adapter, sequence):
    status = None
    for progress, timestamp in sequence:
        status = adapter.process(_frame(progress, timestamp))
    assert status is not None
    return status


# --------------------------------------------------------------------------- reps

def test_full_rep_scores_100_and_completes_one_rep():
    status = _drive(_adapter(), _FULL)
    assert status["counters"] == {
        "attempts": 1, "qualified": 1, "full_rom": 1, "shallow": 0, "invalid": 0,
        "not_counted": {"shallow": 0, "too_fast": 0},
    }
    assert status["last_rep"]["classification"] == "full_rom"
    assert status["last_rep"]["score"] == 100.0
    assert status["last_rep"]["quality"] == "reliable"
    assert status["set"]["completed_reps"] == 1
    assert status["rom"]["rule_id"] == "curl_rom"


def test_shallow_rep_is_rom_only_score_and_counts():
    status = _drive(_adapter(), _SHALLOW)
    assert status["counters"]["shallow"] == 1
    assert status["counters"]["qualified"] == 1  # shallow reps still count
    assert status["last_rep"]["classification"] == "shallow"
    assert status["last_rep"]["rom_factor"] == pytest.approx(0.7 / _GATE)
    assert status["last_rep"]["score"] == 93.3  # ROM-only: no live penalty rules
    assert status["cue"]["text"] == "Shallow rep: Curl all the way up with control."  # warned at once


def test_shallow_rep_emits_reminder_cue_at_start_of_next_rep():
    adapter = _adapter(target_reps=3)
    _drive(adapter, _SHALLOW)
    # Hold extended through the reset dwell into setup.
    setup = None
    for timestamp in range(700, 3301, 100):
        setup = adapter.process(_frame(0.0, timestamp))
    assert setup["phase"] == "setup"
    assert setup["cue"] is None
    # Begin the next curl -> the deferred shallow reminder fires on setup -> ascent.
    ascent = adapter.process(_frame(0.3, 3400))
    assert ascent["phase"] == "ascent"
    assert ascent["cue"]["rule_id"] == "curl_rom"


def test_final_shallow_rep_does_not_queue_a_next_rep_cue():
    adapter = _adapter(target_reps=1)
    assert _drive(adapter, _SHALLOW)["cue"]["text"].startswith("Shallow rep:")
    for timestamp in range(3300, 3700, 100):
        assert adapter.process(_frame(0.0, timestamp))["cue"] is None
    assert adapter.process(_frame(0.3, 3700))["cue"] is None


def test_invalid_micro_attempt_has_no_score_or_set_progress():
    status = _drive(_adapter(), _INVALID)
    assert status["counters"]["invalid"] == 1
    assert status["counters"]["qualified"] == 0
    assert status["last_rep"] is None
    assert status["set"]["completed_reps"] == 0


# --------------------------------------------------------------------- dual-arm ROM

def test_leading_arm_drives_progress_and_rom_payload():
    # Left curled deep, right lagging -> progress is the leading (left) arm.
    status = _adapter().process(_frame(0.8, 0, right_progress=0.4))
    rom = status["rom"]
    assert rom["left_ratio"] == pytest.approx(0.8, abs=1e-3)
    assert rom["right_ratio"] == pytest.approx(0.4, abs=1e-3)
    assert rom["ratio"] == pytest.approx(0.8, abs=1e-3)  # max of the two
    assert rom["weaker_side"] == "right"                 # still named for coaching
    assert rom["full_rom"] is True
    assert rom["left_full"] is True and rom["right_full"] is False


def test_single_arm_curls_count():
    # The right arm hangs throughout (the app's single-arm curl): every left curl counts.
    adapter = _adapter(target_reps=3)
    status = None
    for rep in range(2):
        for progress, ts in _FULL:
            status = adapter.process(_frame(progress, rep * 1000 + ts, right_progress=0.0))
        status = adapter.process(_frame(0.0, rep * 1000 + 900, right_progress=0.0))
    assert status["counters"]["qualified"] == 2
    assert status["counters"]["full_rom"] == 2


def test_elbow_flare_reaches_rank_one_issue_cue_and_configured_score_penalty():
    adapter = _adapter(target_reps=1, enabled_rules=("elbow_flare_corridor",))
    status = None
    for progress, timestamp in _FULL:
        status = adapter.process(
            _frame(progress, timestamp, left_elbow_flare=_FAULT_FLARE_PX)
        )

    assert status is not None
    assert status["last_rep"]["classification"] == "full_rom"
    assert status["last_rep"]["time_score"] == 50.0
    assert status["last_rep"]["score"] == 50.0
    assert status["cue"]["rule_id"] == "elbow_flare_corridor"
    flare = status["last_rep"]["phase_scores"]["ascent"]["rules"][
        "elbow_flare_corridor"
    ]
    assert flare["not_ok_fraction"] == 1.0
    debug = adapter.debug_snapshot()["rules"]["elbow_flare_corridor"]["result"]
    assert debug["not_ok"] is True
    assert debug["side"] == "left"


def test_elbow_flare_warning_is_green_silent_and_unpenalized():
    adapter = _adapter(target_reps=1, enabled_rules=("elbow_flare_corridor",))
    status = None
    for progress, timestamp in _FULL:
        status = adapter.process(
            _frame(progress, timestamp, right_elbow_flare=_WARNING_FLARE_PX)
        )
        assert all(issue["id"] != "elbow_flare_corridor" for issue in status["issues"])

    assert status is not None
    assert status["last_rep"]["score"] == 100.0
    reading = adapter.debug_snapshot()["rules"]["elbow_flare_corridor"]["result"]
    assert reading["state"] == "warning"
    assert reading["skeleton_color"] == "green"


def test_lateral_torso_lean_reaches_rank_two_cue_and_configured_score_penalty():
    adapter = _adapter(target_reps=1, enabled_rules=("lateral_torso_lean",))
    status = None
    for progress, timestamp in _FULL:
        status = adapter.process(_frame(progress, timestamp, torso_lean_deg=8.0))

    assert status is not None
    assert status["last_rep"]["classification"] == "full_rom"
    assert status["last_rep"]["time_score"] == 70.0
    assert status["last_rep"]["score"] == 70.0
    assert status["cue"]["rule_id"] == "lateral_torso_lean"
    lean = status["last_rep"]["phase_scores"]["ascent"]["rules"][
        "lateral_torso_lean"
    ]
    assert lean["not_ok_fraction"] == 1.0
    debug = adapter.debug_snapshot()["rules"]["lateral_torso_lean"]["result"]
    assert debug["not_ok"] is True
    assert debug["side"] == "left"


def test_lateral_torso_warning_is_green_silent_and_unpenalized():
    adapter = _adapter(target_reps=1, enabled_rules=("lateral_torso_lean",))
    status = None
    for progress, timestamp in _FULL:
        status = adapter.process(_frame(progress, timestamp, torso_lean_deg=-4.0))
        assert all(issue["id"] != "lateral_torso_lean" for issue in status["issues"])

    assert status is not None
    assert status["last_rep"]["score"] == 100.0
    reading = adapter.debug_snapshot()["rules"]["lateral_torso_lean"]["result"]
    assert reading["state"] == "warning"
    assert reading["side"] == "right"
    assert reading["skeleton_color"] == "green"


# ------------------------------------------------------------------- tracking + set

def test_missing_shoulder_pauses_tracking_but_a_hidden_arm_does_not():
    adapter = _adapter()
    frame = _keypoints(0.5, v=0.9)
    del frame["right_shoulder"]
    status = adapter.process(TrainingFrame(0, frame))
    assert status["tracking"]["available"] is False
    assert status["rom"]["available"] is False
    frame = _keypoints(0.5, v=0.9)
    del frame["right_wrist"]
    assert adapter.process(TrainingFrame(100, frame))["rom"]["available"] is True


def test_set_completes_after_target_reps():
    adapter = _adapter(target_reps=2)
    _drive(adapter, _FULL)  # rep 1 ends at t=800 (in reset)
    # Rest through the reset dwell into setup (continuous 100 ms steps, no tracking gap).
    for timestamp in (900, 1000, 1100, 1200, 1300):
        adapter.process(_frame(0.0, timestamp))
    # rep 2, continuous timing from t=1400
    second = [(p, 1400 + index * 100) for index, (p, _) in enumerate(_FULL)]
    status = _drive(adapter, second)
    assert status["counters"]["qualified"] == 2
    assert status["set"]["complete"] is True


def test_builder_requires_a_usable_baseline():
    # The ROM signal is normalized against the person's resting hang, so a baseline without both
    # arms cannot build an adapter — it fails loudly rather than measuring against a guess.
    with pytest.raises(BicepCurlAdapterConfigurationError, match="baseline"):
        build_bicep_curl_adapter(baseline={}, target_reps=1, config=_CONFIG)


# --------------------------------------------------- both-arms return (asymmetric lowering)

def _asymmetric_frame(left: float, right: float, timestamp: float) -> TrainingFrame:
    keypoints = _keypoints(left)
    lagging = _keypoints(right)
    for joint in ("shoulder", "elbow", "wrist"):
        keypoints[f"right_{joint}"]["y"] = lagging[f"right_{joint}"]["y"]
    return TrainingFrame(timestamp, keypoints)


def test_rep_does_not_complete_while_one_arm_is_still_curled():
    """A rep is over when BOTH arms are down. Driving the return from the weaker arm ends it the
    instant the FIRST arm lowers — with the other still at the top, above the full-ROM gate."""
    adapter = _adapter()
    # Curl both up, then lower the left briskly while the right stays curled at 0.90.
    climb = [(0.0, 0.0, 0), (0.5, 0.48, 100), (0.95, 0.93, 200), (0.95, 0.93, 300)]
    lower_left_only = [(0.70, 0.92, 400), (0.40, 0.91, 500), (0.05, 0.90, 600), (0.04, 0.90, 700)]
    status = None
    for left, right, timestamp in climb + lower_left_only:
        status = adapter.process(_asymmetric_frame(left, right, timestamp))

    assert status["counters"]["qualified"] == 0, "rep completed with an arm still curled"
    assert status["phase"] == "descent"

    # Only once the right arm comes down too does the rep close.
    for left, right, timestamp in ((0.04, 0.50, 800), (0.03, 0.05, 900)):
        status = adapter.process(_asymmetric_frame(left, right, timestamp))
    assert status["counters"]["qualified"] == 1
    assert status["last_rep"]["classification"] == "full_rom"


def test_consecutive_reps_both_count_when_the_first_returns_unevenly():
    """An uneven return must not disturb the NEXT rep's lifecycle.

    Note this passes under the old weaker-arm logic too — it guards the sequence, it does not
    discriminate the fix. The two tests that do are the ones either side of it."""
    adapter = _adapter(target_reps=3)
    sequence = [
        (0.0, 0.0, 0), (0.5, 0.5, 100), (0.95, 0.95, 200), (0.95, 0.95, 300),
        (0.50, 0.94, 400), (0.05, 0.93, 500),      # left down, right held at the top
        (0.04, 0.50, 600), (0.03, 0.04, 700),      # right follows -> rep 1 closes here
        # Rest through the 500 ms reset dwell (a rep started inside it is not recognised — that is
        # the FSM's own lifecycle, shared with squat, and unrelated to the arms).
        (0.03, 0.03, 800), (0.03, 0.03, 900), (0.03, 0.03, 1000),
        (0.03, 0.03, 1100), (0.03, 0.03, 1200), (0.03, 0.03, 1300),
        (0.5, 0.5, 1400), (0.95, 0.95, 1500), (0.95, 0.95, 1600),   # rep 2, cleanly
        (0.5, 0.5, 1700), (0.04, 0.04, 1800),
    ]
    status = None
    for left, right, timestamp in sequence:
        status = adapter.process(_asymmetric_frame(left, right, timestamp))

    assert status["counters"]["qualified"] == 2, "the rep after an uneven return was dropped"


def test_movement_starts_when_the_leading_arm_leaves_rest():
    """Symmetric with the return: the movement is under way as soon as EITHER arm moves."""
    adapter = _adapter()
    adapter.process(_asymmetric_frame(0.0, 0.0, 0))
    status = adapter.process(_asymmetric_frame(0.5, 0.0, 100))  # only the left arm has moved
    assert status["phase"] == "ascent"


def test_an_inactive_rule_cannot_break_the_adapter():
    """Switching a rule off in switches.yaml is a supported state, not a crash.

    Running a `development` template dark is the documented way to keep training working while its
    bands are still being tuned — and it is the path reached for under pressure, when a rig session
    says the numbers are wrong. Every other test here runs the config with all rules ON, so nothing
    else walks this branch."""
    # Flip a rule ON, then OFF, so the assertion below is about the switch and not about a rule
    # that happened to be dark already.
    active = adapter_for(elbow_flare_corridor=True)
    # RANK order (the scorer sorts by it), not switches.yaml order — the registry's
    # active_live_rule_modules uses declaration order instead, so the two tuples differ.
    assert active.active_rule_ids == (
        "elbow_flare_corridor",  # 1
        "curl_rom",              # 2
        "lateral_torso_lean",    # 3
        "shoulder_elevation",    # 4
    )
    assert "elbow_flare_corridor" in active.runtime_metadata()["signal_reference"]

    adapter = adapter_for(elbow_flare_corridor=False)
    status = adapter.process(_frame(0.5, 0))
    metadata = adapter.runtime_metadata()

    assert adapter.active_rule_ids == (
        "curl_rom",
        "lateral_torso_lean",
        "shoulder_elevation",
    )
    assert status["active_rule_ids"] == [
        "curl_rom",
        "lateral_torso_lean",
        "shoulder_elevation",
    ]
    # The ROM reference is always recorded; the inactive rule's is simply absent rather than null,
    # so a capture never claims a reference it did not measure.
    assert metadata["signal_reference"]["rule_id"] == "curl_rom"
    assert "elbow_flare_corridor" not in metadata["signal_reference"]


def adapter_for(**live_flags: bool):
    contexts = deepcopy(_CONFIG.contexts)
    contexts["live"].update(live_flags)
    return build_bicep_curl_adapter(
        baseline=_BASELINE, target_reps=1, config=replace(_CONFIG, contexts=contexts)
    )


def _smooth_reps(count, *, frame_ms, period_ms=2000.0, rest=0.0, peak=1.0):
    from math import cos, pi
    frames, t = [], 0.0
    while t <= count * period_ms + 300:
        phase = (t % period_ms) / period_ms if t < count * period_ms else 0.0
        frames.append((rest + (peak - rest) * (1 - cos(2 * pi * phase)) / 2, t))
        t += frame_ms
    return frames


def _count_curls(sequence, **frame_options):
    adapter = _adapter(target_reps=10)
    status = None
    for progress, t in sequence:
        status = adapter.process(_frame(progress, t, **frame_options))
    return status["set"]["completed_reps"]


def test_a_slow_camera_counts_every_curl():
    assert _count_curls(_smooth_reps(3, frame_ms=150)) == 3


def test_lowering_without_fully_straightening_still_counts():
    assert _count_curls(_smooth_reps(3, frame_ms=33, rest=0.2)) == 3


def test_quick_back_to_back_curls_each_count():
    assert _count_curls(_smooth_reps(4, frame_ms=33, period_ms=1200)) == 4


def _curler(scale: float, curl: float, *, hips_in_view: bool) -> dict:
    """A front-view double-arm curl. Setup (scale 1) sees the whole body; for the set the person
    steps closer (scale ~2): everything is bigger and the hips and feet leave the bottom of the
    frame, as in a real session."""
    from math import cos, pi
    points = {}
    for side, dx in (("left", -60.0), ("right", 60.0)):
        shoulder = (450.0 + dx * scale, 260.0)
        elbow = (shoulder[0], shoulder[1] + 90.0 * scale)
        wrist_y = elbow[1] + 90.0 * scale * cos(pi * 0.95 * curl)   # the forearm swings up
        hip_v = 0.9 if hips_in_view else 0.2
        points[f"{side}_shoulder"] = {"x": shoulder[0], "y": shoulder[1], "v": 0.95}
        points[f"{side}_elbow"] = {"x": elbow[0], "y": elbow[1], "v": 0.9}
        points[f"{side}_wrist"] = {"x": elbow[0], "y": wrist_y, "v": 0.9}
        points[f"{side}_hip"] = {"x": 450.0 + 0.8 * dx * scale, "y": 260.0 + 250.0 * scale, "v": hip_v}
        points[f"{side}_ankle"] = {"x": 450.0 + dx * scale, "y": 260.0 + 600.0 * scale, "v": hip_v}
    return points


def test_curls_close_to_the_camera_with_the_hips_out_of_frame_count():
    from math import cos, pi
    baseline = {
        name: {"x": p["x"], "y": p["y"]}
        for name, p in _curler(1.0, 0.0, hips_in_view=True).items()
    }
    adapter = build_bicep_curl_adapter(baseline=baseline, target_reps=12, config=_CONFIG)
    status, t = None, 0.0
    for _ in range(4):
        for k in range(40):
            curl = 0.7 * (1 - cos(2 * pi * k / 40)) / 2
            status = adapter.process(TrainingFrame(t, _curler(1.9, curl, hips_in_view=False)))
            t += 50.0
    assert status["tracking"]["available"] is True
    assert status["set"]["completed_reps"] == 4
