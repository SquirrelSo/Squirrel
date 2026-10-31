"""Push-up adapter integration over rules, FSM, timeline, scorer and cues."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.engine.loader import validate_exercise_config
from backend.tests.pushup_fixtures import (
    FRONT_ON_LATERAL_PX,
    FULL,
    INVALID,
    SHALLOW,
    baseline,
    frame,
)
from backend.training.builders import EXERCISE_BUILDERS, build_training_adapter
from backend.training.target_contract import RepTarget, TimeTarget
from backend.workouts.pushup.adapter import (
    PushUpAdapterConfigurationError,
    build_pushup_adapter,
)

# Synthetic reps here are faster and shallower than the live counting policy accepts (conftest).
pytestmark = pytest.mark.usefixtures("legacy_rep_counting")

_CONFIG = validate_exercise_config(
    "pushup", Path(__file__).resolve().parents[1] / "workouts" / "pushup"
)
_BASELINE = baseline()
#: Frames at the top, long enough to clear the FSM's reset dwell before the next rep.
_REST_FRAMES = 8


def adapter(target_reps: int = 3):
    return build_pushup_adapter(
        baseline=_BASELINE, target_reps=target_reps, config=_CONFIG
    )


class Driver:
    """Feed rep-shaped sequences into one adapter, keeping a continuous clock."""

    def __init__(self, target_reps: int = 3, **frame_options) -> None:
        self.adapter = adapter(target_reps)
        self.options = frame_options
        self.t = 0.0
        self.status: dict | None = None

    def rep(self, sequence, **overrides) -> dict:
        options = {**self.options, **overrides}
        for progress, _ in sequence:
            self.status = self.adapter.process(frame(progress, self.t, **options))
            self.t += 100.0
        return self.rest(**overrides)

    def rest(self, **overrides) -> dict:
        options = {**self.options, **overrides}
        for _ in range(_REST_FRAMES):
            self.status = self.adapter.process(frame(0.0, self.t, **options))
            self.t += 100.0
        assert self.status is not None
        return self.status


class TestRepCounting:
    def test_a_clean_rep_is_counted_scored_and_classified_full(self):
        status = Driver().rep(FULL)
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

    def test_a_shallow_rep_counts_but_scores_lower(self):
        driver = Driver()
        driver.rep(FULL)
        status = driver.rep(SHALLOW)
        assert status["counters"]["qualified"] == 2
        assert status["counters"]["shallow"] == 1
        assert status["last_rep"]["classification"] == "shallow"
        assert status["last_rep"]["score"] < 100.0

    def test_a_twitch_is_a_diagnostic_attempt_that_never_advances_the_set(self):
        driver = Driver()
        driver.rep(FULL)
        status = driver.rep(INVALID)
        assert status["counters"]["attempts"] == 2
        assert status["counters"]["invalid"] == 1
        assert status["counters"]["qualified"] == 1
        assert status["set"]["completed_reps"] == 1
        assert status["set"]["remaining_reps"] == 2

    def test_a_full_set_completes(self):
        driver = Driver(target_reps=3)
        for _ in range(3):
            status = driver.rep(FULL)
        assert status["set"]["complete"] is True
        assert status["set"]["scored_reps"] == 3
        assert status["set"]["average_score"] == 100.0

    def test_phases_advance_through_the_rep(self):
        driver = Driver()
        seen = set()
        for progress, _ in FULL:
            seen.add(driver.adapter.process(frame(progress, driver.t)).get("phase"))
            driver.t += 100.0
        assert {"setup", "descent", "bottom", "ascent"} <= seen


class TestRangeOfMotion:
    def test_the_rom_block_reports_the_signal_and_its_source(self):
        driver = Driver()
        status = driver.adapter.process(frame(0.5, 0.0))
        rom = status["rom"]
        assert rom["rule_id"] == "pushup_depth"
        assert rom["available"] is True
        assert rom["ratio"] == pytest.approx(0.5, abs=0.02)
        assert rom["percent"] == pytest.approx(50, abs=2)
        # Push-up-specific extras a tuning pass needs straight from the capture.
        assert rom["elbow_angle_deg"] == pytest.approx(132.5, abs=1.0)
        assert rom["analysed_side"] in ("left", "right")

    def test_reaching_the_gate_marks_the_frame_full_depth(self):
        driver = Driver()
        assert driver.adapter.process(frame(0.95, 0.0))["rom"]["full_depth"] is True
        assert driver.adapter.process(frame(0.5, 100.0))["rom"]["full_depth"] is False

    def test_a_shallow_rep_cues_depth_on_the_way_into_the_next_one(self):
        """Coaching lands where the user can act on it, not on the rep already finished."""
        driver = Driver()
        driver.rep(SHALLOW)
        cues = []
        for progress, _ in FULL:
            status = driver.adapter.process(frame(progress, driver.t))
            driver.t += 100.0
            if status["cue"]:
                cues.append(status["cue"]["rule_id"])
        assert "pushup_depth" in cues


class TestBodyLineFault:
    def test_sagging_hips_are_reported_and_cost_score(self):
        clean = Driver().rep(FULL)
        sagging = Driver().rep(FULL, sag=0.09)
        assert sagging["last_rep"]["score"] < clean["last_rep"]["score"]

    def test_the_fault_names_its_direction(self):
        driver = Driver()
        status = None
        for progress, _ in FULL:
            status = driver.adapter.process(frame(progress, driver.t, sag=0.09))
            driver.t += 100.0
            if status["issues"]:
                break
        issues = {issue["id"]: issue for issue in status["issues"]}
        assert issues["body_line"]["side"] == "sag"
        assert issues["body_line"]["skeleton_color"] == "red"

    def test_piked_hips_are_reported_as_the_opposite_fault(self):
        driver = Driver()
        status = None
        for progress, _ in FULL:
            status = driver.adapter.process(frame(progress, driver.t, sag=-0.09))
            driver.t += 100.0
            if status["issues"]:
                break
        assert {issue["side"] for issue in status["issues"]} == {"pike"}


class TestCameraCheck:
    """A front-on view only cues: it never stops push-ups from counting."""

    def test_a_front_on_rep_still_counts(self):
        status = Driver().rep(FULL, lateral=FRONT_ON_LATERAL_PX, far_v=0.9)
        assert status["counters"]["qualified"] == 1
        assert status["tracking"]["available"] is True
        assert status["tracking"]["invalidated_by"] == []

    def test_the_user_is_told_what_to_fix(self):
        driver = Driver()
        status = None
        for progress, _ in FULL:
            status = driver.adapter.process(
                frame(progress, driver.t, lateral=FRONT_ON_LATERAL_PX, far_v=0.9)
            )
            driver.t += 100.0
            if status["cue"]:
                break
        assert status["cue"]["rule_id"] == "side_view_orientation"
        assert "side to the camera" in status["cue"]["text"]

    def test_turning_front_on_and_back_keeps_counting(self):
        driver = Driver()
        driver.rep(FULL, lateral=FRONT_ON_LATERAL_PX, far_v=0.9)
        driver.rest()
        status = driver.rep(FULL)
        assert status["counters"]["qualified"] == 2
        assert status["tracking"]["available"] is True
        assert status["tracking"]["invalidated_by"] == []

    def test_one_stray_frame_does_not_interrupt_a_rep(self):
        """Hysteresis in the rule is what keeps a single noisy frame from voiding a rep."""
        driver = Driver()
        status = None
        for index, (progress, _) in enumerate(FULL):
            options = (
                {"lateral": FRONT_ON_LATERAL_PX, "far_v": 0.9} if index == 2 else {}
            )
            status = driver.adapter.process(frame(progress, driver.t, **options))
            driver.t += 100.0
        status = driver.rest()
        assert status["counters"]["qualified"] == 1

    def test_it_never_contributes_to_a_score(self):
        """Pausing is not penalising: a wrong camera angle is not a fault in the user's form."""
        status = Driver().rep(FULL)
        assert status["score_coverage"]["active_rule_ids"] == ["body_line", "pushup_depth"]
        assert status["score_coverage"]["reliable"] is True
        assert status["last_rep"]["score"] == 100.0

    def test_it_is_still_reported_when_the_body_cannot_be_measured(self):
        """Arm out of frame AND turned front-on: the camera cue is the actionable one."""
        driver = Driver()
        status = None
        for _ in range(_REST_FRAMES):
            partial = frame(0.0, driver.t, lateral=FRONT_ON_LATERAL_PX, far_v=0.9).keypoints
            for name in ("left_elbow", "right_elbow"):
                partial[name] = {**partial[name], "v": 0.1}
            status = driver.adapter.process(type(frame(0.0, driver.t))(driver.t, partial))
            driver.t += 100.0
        assert status["tracking"]["available"] is False
        assert "pushup_depth" in status["tracking"]["unavailable_rule_ids"]
        assert {issue["id"] for issue in status["issues"]} == {"side_view_orientation"}


class TestTrackingLoss:
    def test_an_untracked_frame_pauses_rather_than_scoring(self):
        driver = Driver()
        status = driver.adapter.process(frame(0.5, 0.0, v=0.1, far_v=0.1))
        assert status["tracking"]["available"] is False
        assert status["rom"]["available"] is False
        assert status["counters"]["attempts"] == 0

    def test_a_rep_interrupted_by_tracking_loss_is_discarded_not_counted(self):
        driver = Driver()
        for progress, _ in FULL[:4]:
            driver.adapter.process(frame(progress, driver.t))
            driver.t += 100.0
        for _ in range(30):
            status = driver.adapter.process(frame(0.9, driver.t, v=0.1, far_v=0.1))
            driver.t += 100.0
        assert status["counters"]["qualified"] == 0


class TestWiring:
    def test_the_registry_builds_this_adapter_for_a_rep_target(self):
        built = build_training_adapter(
            "pushup", baseline=_BASELINE, target=RepTarget("reps", 2), config=_CONFIG
        )
        assert built.active_rule_ids == ("body_line", "pushup_depth", "side_view_orientation")
        assert EXERCISE_BUILDERS["pushup"] is build_pushup_adapter

    def test_a_timed_target_is_refused(self):
        with pytest.raises(ValueError, match="does not match the exercise movement type"):
            build_training_adapter(
                "pushup", baseline=_BASELINE, target=TimeTarget("time", 30_000), config=_CONFIG
            )

    def test_runtime_metadata_records_the_per_person_signal_reference(self):
        metadata = adapter().runtime_metadata()
        reference = metadata["signal_reference"]
        assert reference["rule_id"] == "pushup_depth"
        assert reference["target_elbow_angle_deg"] == 90.0
        assert set(reference["baseline_elbow_angles_deg"]) == {"left", "right"}
        assert set(reference["body_line_baseline_offsets"]) == {"left", "right"}

    def test_debug_snapshot_covers_every_template(self):
        driver = Driver()
        driver.adapter.process(frame(0.5, 0.0))
        rules = driver.adapter.debug_snapshot()["rules"]
        assert set(rules) == set(_CONFIG.templates)
        assert rules["plank_ready"]["active"] is False
        assert rules["pushup_depth"]["available"] is True

    def test_an_unusable_baseline_is_refused_with_a_clear_error(self):
        with pytest.raises(PushUpAdapterConfigurationError, match="captured extended"):
            build_pushup_adapter(baseline=baseline(0.8), target_reps=1, config=_CONFIG)

    def test_target_reps_must_be_a_positive_integer(self):
        with pytest.raises(PushUpAdapterConfigurationError, match="positive integer"):
            build_pushup_adapter(baseline=_BASELINE, target_reps=0, config=_CONFIG)


def _smooth_reps(count, *, frame_ms, period_ms=2000.0, rest=0.0, peak=1.0):
    """`count` back-to-back reps (a smooth down-and-up), sampled every `frame_ms`, returning only
    to `rest` between them."""
    from math import cos, pi
    frames, t = [], 0.0
    while t <= count * period_ms + 300:
        phase = (t % period_ms) / period_ms if t < count * period_ms else 0.0
        frames.append((rest + (peak - rest) * (1 - cos(2 * pi * phase)) / 2, t))
        t += frame_ms
    return frames


class TestRealCameras:
    """Every real push-up counts (configs/fsm.yaml)."""

    def _count(self, sequence):
        a = adapter(target_reps=10)
        status = None
        for progress, t in sequence:
            status = a.process(frame(progress, t))
        return status["set"]["completed_reps"]

    def test_a_slow_camera_counts_every_push_up(self):
        assert self._count(_smooth_reps(3, frame_ms=150)) == 3

    def test_pressing_up_without_locking_out_still_counts(self):
        assert self._count(_smooth_reps(3, frame_ms=33, rest=0.2)) == 3

    def test_quick_back_to_back_push_ups_each_count(self):
        assert self._count(_smooth_reps(4, frame_ms=33, period_ms=1200)) == 4
