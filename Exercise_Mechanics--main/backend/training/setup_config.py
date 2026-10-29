"""Validated generic setup configuration projected from an exercise bundle."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from backend.engine.loader import ExerciseConfiguration, load_exercise_config


@dataclass(frozen=True)
class SetupConfig:
    exercise: str
    required_keypoints: tuple[str, ...]
    pre_check_templates: tuple[str, ...]
    baseline_capture_templates: tuple[str, ...]
    stable_ms: float
    baseline_required: bool
    baseline_file: str | None
    capture_duration_ms: float
    min_valid_samples: int
    min_valid_coverage: float
    invalid_pause_ms: float
    invalid_reset_ms: float
    max_joint_stddev_torso: float
    # Joints needed on at least one side (setup.yaml `either_side`), by base name ("shoulder").
    either_side: tuple[str, ...] = ()


@lru_cache(maxsize=None)
def load_setup(slug: str) -> SetupConfig:
    return build_setup_config(load_exercise_config(slug))


def build_setup_config(bundle: ExerciseConfiguration) -> SetupConfig:
    spec = bundle.setup
    pre_check = spec["pre_check"]
    baseline = spec["baseline"]
    capture = baseline["capture"]
    pre_check_templates = tuple(
        template_id
        for template_id, enabled in bundle.contexts["pre_check"].items()
        if enabled
    )
    baseline_templates = tuple(
        template_id
        for template_id, enabled in bundle.contexts["baseline_capture"].items()
        if enabled
    )
    return SetupConfig(
        exercise=str(spec["exercise"]),
        required_keypoints=tuple(spec["keypoints"]),
        either_side=tuple(spec.get("either_side") or ()),
        pre_check_templates=pre_check_templates,
        baseline_capture_templates=baseline_templates,
        stable_ms=float(pre_check["stable_ms"]) if pre_check_templates else 0.0,
        baseline_required=bool(baseline["required"]),
        baseline_file=baseline.get("file"),
        capture_duration_ms=float(capture["duration_ms"]),
        min_valid_samples=int(capture["min_valid_samples"]),
        min_valid_coverage=float(capture["min_valid_coverage"]),
        invalid_pause_ms=float(capture["invalid_pause_ms"]),
        invalid_reset_ms=float(capture["invalid_reset_ms"]),
        max_joint_stddev_torso=float(capture["max_joint_stddev_torso"]),
    )
