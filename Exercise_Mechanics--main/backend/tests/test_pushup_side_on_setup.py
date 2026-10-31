"""Field test: push-ups could not be recorded; the camera angle was never accepted, and nothing said
why. Side-on, the far arm, hip and ankle are hidden behind the near ones, and the setup required
both sides at full confidence, so exactly the view push-ups need could never pass. These tests drive
the real push-up configuration with the far side hidden."""

from __future__ import annotations

import random
from math import pi, sin
from pathlib import Path

from backend.engine.loader import validate_exercise_config
from backend.tests.pushup_fixtures import FRONT_ON_LATERAL_PX, keypoints
from backend.training.setup_config import build_setup_config
from backend.training.setup_flow import PRECHECK, VALIDATING, SetupOrchestrator
from backend.workouts.pushup.setup_adapter import PushUpSetupAdapter

_CONFIG = validate_exercise_config("pushup", Path(__file__).resolve().parents[1] / "workouts" / "pushup")
_TEMPLATES = ("plank_ready", "side_view_orientation")


def _jitter(frame: dict, rng: random.Random, px: float) -> dict:
    return {k: {**p, "x": p["x"] + rng.gauss(0, px), "y": p["y"] + rng.gauss(0, px)} for k, p in frame.items()}


def _run(frame_for, seconds: float = 7.0, fps: int = 30):
    flow = SetupOrchestrator(build_setup_config(_CONFIG), PushUpSetupAdapter(_CONFIG))
    statuses = []
    for i in range(int(seconds * fps)):
        statuses.append(flow.update(frame_for(i), i * 1000.0 / fps))
    return flow, statuses


def test_a_side_on_plank_with_the_far_side_hidden_passes_both_conditions():
    results = {r.template_id: r for r in PushUpSetupAdapter(_CONFIG).evaluate(_TEMPLATES, keypoints(0.0, far_v=0.15))}
    assert results["plank_ready"].passed
    assert results["side_view_orientation"].passed
    assert results["side_view_orientation"].measurements["far_side_hidden"] is True


def test_setup_completes_side_on_with_the_far_side_hidden():
    rng = random.Random(7)
    flow, statuses = _run(lambda i: _jitter(keypoints(0.0, far_v=0.15), rng, 1.5))
    assert statuses[-1].phase == VALIDATING
    assert all(s.missing == () for s in statuses)
    assert flow.baseline is not None
    # the hidden side's predicted positions are kept, so the reference has every joint
    assert {"left_elbow", "right_elbow", "left_ankle", "right_ankle"} <= set(flow.baseline)


def test_front_on_is_still_refused_with_the_far_side_hidden():
    results = {r.template_id: r for r in PushUpSetupAdapter(_CONFIG).evaluate(
        _TEMPLATES, keypoints(0.0, far_v=0.15, lateral=FRONT_ON_LATERAL_PX))}
    assert results["side_view_orientation"].reason_id == "camera_not_side_on"


def test_when_no_side_is_visible_it_says_what_is_missing_not_turn_side_on():
    results = {r.template_id: r for r in PushUpSetupAdapter(_CONFIG).evaluate(_TEMPLATES, keypoints(0.0, v=0.2, far_v=0.2))}
    side = results["side_view_orientation"]
    assert side.status == "unavailable" and side.cue != "Turn your side to the camera."
    flow, statuses = _run(lambda i: keypoints(0.0, v=0.2, far_v=0.2), seconds=1.0)
    assert statuses[-1].phase == PRECHECK
    assert set(statuses[-1].missing) == {"left_shoulder", "left_elbow", "left_wrist", "left_hip", "left_ankle"}


def test_each_plank_problem_has_its_own_cue():
    adapter = PushUpSetupAdapter(_CONFIG)
    bent = {r.template_id: r for r in adapter.evaluate(_TEMPLATES, keypoints(0.6))}["plank_ready"]
    sag = {r.template_id: r for r in adapter.evaluate(_TEMPLATES, keypoints(0.0, sag=0.3))}["plank_ready"]
    assert bent.reason_id == "arms_not_extended" and "Straighten your arms" in bent.cue
    assert sag.reason_id == "body_not_straight" and "straight line" in sag.cue


def test_why_a_capture_was_rejected_stays_on_screen_through_the_next_hold():
    # A valid plank the whole time, but rocking back and forth through the capture.
    def frame(i: int) -> dict:
        dx = 0.0 if i < 60 else 40.0 * sin(i / 6.0)
        return {k: {**p, "x": p["x"] + dx} for k, p in keypoints(0.0, far_v=0.15).items()}
    flow, statuses = _run(frame, seconds=6.0)
    rejected = next(i for i, s in enumerate(statuses) if any(r.reason_id == "baseline_unstable" for r in s.validation_results))
    after = statuses[rejected + 1: rejected + 20]
    assert after and all(s.phase == PRECHECK for s in after)
    assert all(any(r.reason_id == "baseline_unstable" for r in s.validation_results) for s in after)


def test_live_push_ups_count_side_on_with_the_far_side_hidden():
    from backend.tests.pushup_fixtures import baseline, frame
    from backend.workouts.pushup.adapter import build_pushup_adapter

    adapter = build_pushup_adapter(baseline=baseline(), target_reps=3)
    t, status = 0, None
    for _ in range(3):  # three controlled push-ups, 2 s each, then a short pause at the top
        for step in range(0, 2000, 50):
            status = adapter.process(frame(sin(pi * step / 2000), t, far_v=0.15))
            assert status["tracking"]["available"]
            t += 50
        for _ in range(10):
            status = adapter.process(frame(0.0, t, far_v=0.15))
            t += 50
    assert status["set"]["completed_reps"] == 3
    assert status["counters"]["not_counted"] == {"shallow": 0, "too_fast": 0}

