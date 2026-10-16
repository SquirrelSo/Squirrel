"""High Knee front-view readiness and persisted baseline validation."""

from __future__ import annotations

from math import isclose, isfinite
from pathlib import Path

from backend.engine.loader import ExerciseConfiguration, validate_exercise_config
from backend.training.baseline import BaselineQuality
from backend.training.setup_contract import BaselineValidation, ConditionResult
from backend.workouts.high_knee.rules.setup_readiness import (
    RULE_ID,
    HighKneeSetupReadinessRule,
    failure_reason,
)

_PACKAGE_DIR = Path(__file__).resolve().parent


class HighKneeSetupAdapter:
    def __init__(self, config: ExerciseConfiguration) -> None:
        self._config = config
        template = config.templates[RULE_ID]
        self._readiness = HighKneeSetupReadinessRule(template["setup_policy"])

    def evaluate(
        self,
        template_ids: tuple[str, ...],
        keypoints: dict,
    ) -> tuple[ConditionResult, ...]:
        return tuple(
            self._evaluate_one(template_id, keypoints, reference=False)
            for template_id in template_ids
        )

    def validate_baseline(
        self,
        baseline: dict,
        quality: BaselineQuality,
        template_ids: tuple[str, ...],
    ) -> BaselineValidation:
        results = [
            self._evaluate_one(template_id, baseline, reference=True)
            for template_id in template_ids
        ]
        results.append(self._quality_result(quality))
        output = tuple(results)
        return BaselineValidation(all(result.passed for result in output), output)

    def _evaluate_one(
        self,
        template_id: str,
        keypoints: dict,
        *,
        reference: bool,
    ) -> ConditionResult:
        if template_id != RULE_ID:
            raise ValueError(f"unsupported High Knee setup template: {template_id}")
        template = self._config.templates[template_id]
        reading = (
            self._readiness.read_reference(keypoints)
            if reference
            else self._readiness.read(keypoints)
        )
        if reading is None:
            return ConditionResult(
                template_id,
                "unavailable",
                "setup_geometry_unavailable",
                template["cue"],
            )
        reason = failure_reason(reading)
        return ConditionResult(
            template_id,
            "passed" if reading.passed else "failed",
            reason,
            None if reading.passed else template["cue"],
            reading.measurements,
        )

    def _quality_result(self, quality: BaselineQuality) -> ConditionResult:
        capture = self._config.setup["baseline"]["capture"]
        if not isinstance(quality, BaselineQuality):
            return ConditionResult(
                "baseline_quality",
                "unavailable",
                "baseline_quality_unavailable",
                "Hold still and keep your full body visible.",
            )
        expected_coverage = (
            quality.valid_samples / quality.observed_frames
            if quality.observed_frames > 0
            else 0.0
        )
        quality_consistent = (
            quality.valid_samples >= 0
            and quality.observed_frames >= quality.valid_samples
            and isfinite(quality.valid_coverage)
            and isfinite(quality.valid_duration_ms)
            and isfinite(quality.max_joint_stddev_px)
            and quality.valid_duration_ms >= 0
            and quality.max_joint_stddev_px >= 0
            and quality.max_joint_stddev_rel is not None
            and isfinite(quality.max_joint_stddev_rel)
            and isclose(
                quality.valid_coverage,
                expected_coverage,
                rel_tol=0.0,
                abs_tol=1e-6,
            )
        )
        passed = (
            quality_consistent
            and quality.valid_samples >= int(capture["min_valid_samples"])
            and quality.valid_coverage >= float(capture["min_valid_coverage"])
            and quality.valid_duration_ms >= float(capture["duration_ms"])
            and quality.max_joint_stddev_rel <= float(capture["max_joint_stddev_torso"])
        )
        return ConditionResult(
            "baseline_quality",
            "passed" if passed else "failed",
            None if passed else "baseline_unstable_or_incomplete",
            None if passed else "Hold still and keep your full body visible.",
            {
                "valid_samples": quality.valid_samples,
                "valid_coverage": quality.valid_coverage,
                "valid_duration_ms": quality.valid_duration_ms,
                "max_joint_stddev_px": quality.max_joint_stddev_px,
                "max_joint_stddev_torso": quality.max_joint_stddev_rel,
            },
        )


def build_high_knee_setup_adapter(
    *,
    config: ExerciseConfiguration | None = None,
) -> HighKneeSetupAdapter:
    selected = config or validate_exercise_config("high_knee", _PACKAGE_DIR)
    return HighKneeSetupAdapter(selected)
