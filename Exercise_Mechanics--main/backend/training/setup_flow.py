"""Generic combined setup gate and quality-aware baseline capture state machine."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from numbers import Real

from backend.config import CONFIDENCE_MIN
from backend.core.keypoints import missing_either_side, missing_keypoints
from backend.training.baseline import BaselineCollector, BaselineQuality
from backend.training.setup_config import SetupConfig
from backend.training.setup_contract import ConditionResult, SetupExerciseAdapter

PRECHECK, COLLECTING, VALIDATING, READY = (
    "precheck",
    "collecting",
    "validating",
    "ready",
)


@dataclass(frozen=True)
class SetupStatus:
    phase: str
    missing: tuple[str, ...]
    conditions: tuple[ConditionResult, ...]
    failures: tuple[ConditionResult, ...]
    dwell_ms: float
    stable_ms: float
    capture_valid_ms: float
    capture_required_ms: float
    capture_progress: float
    frames_collected: int
    min_valid_samples: int
    observed_frames: int
    valid_coverage: float
    invalid_ms: float
    capture_paused: bool
    baseline_candidate_ready: bool
    baseline_ready: bool
    quality: BaselineQuality | None
    validation_results: tuple[ConditionResult, ...]


class SetupOrchestrator:
    """Exercise-neutral timing and quality flow over adapter-supplied condition results."""

    def __init__(
        self,
        config: SetupConfig,
        exercise_adapter: SetupExerciseAdapter,
        *,
        min_visibility: float = CONFIDENCE_MIN,
    ) -> None:
        self._config = config
        self._adapter = exercise_adapter
        self._min_visibility = float(min_visibility)
        self._phase = PRECHECK
        self._precheck_since: float | None = None
        # When the current run of failing pre-check frames began (None while passing).
        self._precheck_failing_since: float | None = None
        self._last_timestamp: float | None = None

        self._collector = self._new_collector()
        self._capture_last_ms: float | None = None
        self._previous_capture_valid = False
        self._capture_valid_ms = 0.0
        self._invalid_since_ms: float | None = None
        self._observed_frames = 0

        self._baseline: dict | None = None
        self._quality: BaselineQuality | None = None
        self._validation_results: tuple[ConditionResult, ...] = ()
        self._last_conditions: tuple[ConditionResult, ...] = ()
        self._last_missing: tuple[str, ...] = ()

    @property
    def phase(self) -> str:
        return self._phase

    @property
    def baseline(self) -> dict | None:
        return self._baseline

    @property
    def quality(self) -> BaselineQuality | None:
        return self._quality

    @property
    def collector(self) -> BaselineCollector:
        return self._collector

    def update(self, keypoints: dict, now_ms: float) -> SetupStatus:
        timestamp = _timestamp(now_ms)
        if self._last_timestamp is not None and timestamp < self._last_timestamp:
            raise ValueError("setup timestamp must be monotonic")
        self._last_timestamp = timestamp
        if not isinstance(keypoints, dict):
            raise ValueError("setup keypoints must be a mapping")
        if self._phase in (VALIDATING, READY):
            return self.status()
        if self._phase == PRECHECK:
            self._update_precheck(keypoints, timestamp)
        else:
            self._update_capture(keypoints, timestamp)
        return self.status()

    def mark_ready(self) -> SetupStatus:
        if self._phase != VALIDATING:
            raise RuntimeError("setup can become ready only after baseline validation")
        if self._config.baseline_required and (self._baseline is None or self._quality is None):
            raise RuntimeError("validated setup has no baseline candidate")
        self._phase = READY
        return self.status()

    def reject_candidate(self, reason_id: str, cue: str | None = None) -> SetupStatus:
        if self._phase != VALIDATING:
            raise RuntimeError("only a validating candidate can be rejected")
        failure = ConditionResult("baseline", "failed", reason_id, cue)
        self._reset_to_precheck((failure,))
        return self.status()

    def status(self) -> SetupStatus:
        failures = tuple(result for result in self._last_conditions if not result.passed)
        invalid_ms = (
            0.0
            if self._invalid_since_ms is None or self._last_timestamp is None
            else max(0.0, self._last_timestamp - self._invalid_since_ms)
        )
        coverage = (
            self._collector.frame_count / self._observed_frames
            if self._observed_frames
            else 0.0
        )
        dwell = (
            0.0
            if self._precheck_since is None or self._last_timestamp is None
            else max(0.0, self._last_timestamp - self._precheck_since)
        )
        return SetupStatus(
            phase=self._phase,
            missing=self._last_missing,
            conditions=self._last_conditions,
            failures=failures,
            dwell_ms=round(dwell, 3),
            stable_ms=self._config.stable_ms,
            capture_valid_ms=round(self._capture_valid_ms, 3),
            capture_required_ms=self._config.capture_duration_ms,
            capture_progress=round(
                min(1.0, self._capture_valid_ms / self._config.capture_duration_ms),
                6,
            ),
            frames_collected=self._collector.frame_count,
            min_valid_samples=self._config.min_valid_samples,
            observed_frames=self._observed_frames,
            valid_coverage=round(coverage, 6),
            invalid_ms=round(invalid_ms, 3),
            capture_paused=(
                self._invalid_since_ms is not None
                and invalid_ms >= self._config.invalid_pause_ms
            ),
            baseline_candidate_ready=self._phase in (VALIDATING, READY),
            baseline_ready=self._phase == READY,
            quality=self._quality,
            validation_results=self._validation_results,
        )

    def _update_precheck(self, keypoints: dict, now_ms: float) -> None:
        missing = self._missing(keypoints)
        results = self._adapter.evaluate(self._config.pre_check_templates, keypoints)
        self._assert_result_ids(self._config.pre_check_templates, results)
        self._last_missing = missing
        self._last_conditions = results
        # The reason the last capture was rejected (unsteady, tracking gap, validation) stays in the
        # status until the next capture starts, so the person can read why the ring emptied.
        all_pass = not missing and all(result.passed for result in results)
        if not all_pass:
            # A flicker shorter than invalid_pause_ms (landmark jitter: a relaxed knee read at
            # 159 deg for a frame) does not restart the stable hold; a real failure does. Without
            # this grace, one noisy frame restarts the whole hold, and on a phone's lighter pose
            # model a person standing correctly can be kept here indefinitely. Failing frames never
            # complete the hold (that happens only below, on a passing frame).
            if self._precheck_since is None:
                return
            if self._precheck_failing_since is None:
                self._precheck_failing_since = now_ms
            if now_ms - self._precheck_failing_since >= self._config.invalid_pause_ms:
                self._precheck_since = None
                self._precheck_failing_since = None
            return
        if self._precheck_failing_since is not None:
            # The failure lasted until this passing frame: too long a run restarts the hold here.
            if now_ms - self._precheck_failing_since >= self._config.invalid_pause_ms:
                self._precheck_since = None
            self._precheck_failing_since = None
        if self._precheck_since is None:
            self._precheck_since = now_ms
        if now_ms - self._precheck_since >= self._config.stable_ms:
            self._phase = COLLECTING
            self._begin_capture()

    def _update_capture(self, keypoints: dict, now_ms: float) -> None:
        missing = self._missing(keypoints)
        results = self._adapter.evaluate(
            self._config.baseline_capture_templates,
            keypoints,
        )
        self._assert_result_ids(self._config.baseline_capture_templates, results)
        self._last_missing = missing
        self._last_conditions = results
        current_valid = not missing and all(result.passed for result in results)

        delta = 0.0 if self._capture_last_ms is None else now_ms - self._capture_last_ms
        if delta > self._config.invalid_reset_ms:
            failure = ConditionResult(
                "capture",
                "failed",
                "capture_tracking_gap",
                "Hold the setup position while capture is active.",
            )
            self._reset_to_precheck((failure,))
            return
        if self._previous_capture_valid:
            self._capture_valid_ms += delta
        self._capture_last_ms = now_ms
        self._observed_frames += 1

        if current_valid:
            self._invalid_since_ms = None
            self._collector.add(keypoints)
        else:
            if self._invalid_since_ms is None:
                self._invalid_since_ms = now_ms
            if now_ms - self._invalid_since_ms >= self._config.invalid_reset_ms:
                self._reset_to_precheck(results)
                return
        self._previous_capture_valid = current_valid

        if self._capture_valid_ms < self._config.capture_duration_ms:
            return
        if self._collector.frame_count < self._config.min_valid_samples:
            return
        coverage = self._collector.frame_count / self._observed_frames
        if coverage < self._config.min_valid_coverage:
            return

        quality = self._collector.quality(
            observed_frames=self._observed_frames,
            valid_duration_ms=self._capture_valid_ms,
        )
        # Stillness relative to the person's size (baseline.BaselineQuality): pixels would demand
        # an ever steadier stance the closer the person stands.
        if (
            quality.max_joint_stddev_rel is None
            or quality.max_joint_stddev_rel > self._config.max_joint_stddev_torso
        ):
            failure = ConditionResult(
                "baseline_quality",
                "failed",
                "baseline_unstable",
                "Hold still and keep the full body visible.",
                {
                    "max_joint_stddev_px": quality.max_joint_stddev_px,
                    "body_scale_px": quality.body_scale_px,
                    "max_joint_stddev_torso": quality.max_joint_stddev_rel,
                    "allowed_torso": self._config.max_joint_stddev_torso,
                },
            )
            self._reset_to_precheck((failure,))
            return
        baseline = self._collector.median()
        if baseline is None:
            self._reset_to_precheck(
                (ConditionResult("baseline", "unavailable", "baseline_empty"),)
            )
            return
        validation = self._adapter.validate_baseline(
            baseline,
            quality,
            self._config.baseline_capture_templates,
        )
        self._validation_results = validation.results
        if not validation.passed:
            self._reset_to_precheck(validation.results)
            return
        self._baseline = baseline
        self._quality = quality
        self._phase = VALIDATING

    def _begin_capture(self) -> None:
        self._collector = self._new_collector()
        self._capture_last_ms = None
        self._previous_capture_valid = False
        self._capture_valid_ms = 0.0
        self._invalid_since_ms = None
        self._observed_frames = 0
        self._baseline = None
        self._quality = None
        self._validation_results = ()

    def _reset_to_precheck(
        self,
        validation_results: tuple[ConditionResult, ...],
    ) -> None:
        self._phase = PRECHECK
        self._precheck_since = None
        self._precheck_failing_since = None
        self._begin_capture()
        self._validation_results = validation_results

    def _missing(self, keypoints: dict) -> tuple[str, ...]:
        return (
            *missing_keypoints(keypoints, self._config.required_keypoints, self._min_visibility),
            *missing_either_side(keypoints, self._config.either_side, self._min_visibility),
        )

    def _new_collector(self) -> BaselineCollector:
        return BaselineCollector(
            self._config.required_keypoints,
            min_visibility=self._min_visibility,
            either_side=self._config.either_side,
        )

    @staticmethod
    def _assert_result_ids(
        selected: tuple[str, ...],
        results: tuple[ConditionResult, ...],
    ) -> None:
        actual = tuple(result.template_id for result in results)
        if actual != selected:
            raise RuntimeError(
                f"setup adapter result mismatch; selected={selected}, actual={actual}"
            )


def _timestamp(value: object) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise ValueError("setup timestamp must be numeric")
    result = float(value)
    if not isfinite(result):
        raise ValueError("setup timestamp must be finite")
    return result
