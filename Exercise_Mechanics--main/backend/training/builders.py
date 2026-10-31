"""Small explicit construction boundary from enabled exercise IDs to live adapters."""

from __future__ import annotations

from collections.abc import Callable
from inspect import signature
from typing import Protocol

from backend.core.frame import TrainingFrame
from backend.engine.loader import ExerciseConfiguration, load_exercise_config
from backend.training.setup_contract import SetupExerciseAdapter
from backend.training.target_contract import MovementTarget, RepTarget, TimeTarget
from backend.workouts.bicep_curl.adapter import build_bicep_curl_adapter
from backend.workouts.bicep_curl.setup_adapter import build_bicep_curl_setup_adapter
from backend.workouts.high_knee.adapter import build_high_knee_adapter
from backend.workouts.high_knee.setup_adapter import build_high_knee_setup_adapter
from backend.workouts.catalog import load_catalog
from backend.workouts.pushup.adapter import build_pushup_adapter
from backend.workouts.pushup.setup_adapter import build_pushup_setup_adapter
from backend.workouts.squat.adapter import build_squat_adapter
from backend.workouts.squat.setup_adapter import build_squat_setup_adapter


class TrainingAdapter(Protocol):
    def process(self, frame: TrainingFrame) -> dict: ...

    def debug_snapshot(self) -> dict: ...

    def runtime_metadata(self) -> dict: ...


AdapterBuilder = Callable[..., TrainingAdapter]

EXERCISE_BUILDERS: dict[str, AdapterBuilder] = {
    "squat": build_squat_adapter,
    "bicep_curl": build_bicep_curl_adapter,
    "high_knee": build_high_knee_adapter,
    "pushup": build_pushup_adapter,
}

_SETUP_BUILDERS: dict[str, Callable[[], SetupExerciseAdapter]] = {
    "squat": build_squat_setup_adapter,
    "bicep_curl": build_bicep_curl_setup_adapter,
    "high_knee": build_high_knee_setup_adapter,
    "pushup": build_pushup_setup_adapter,
}


def validate_training_builders() -> tuple[str, ...]:
    """Fail startup if enabled catalog entries and explicit adapter builders drift apart."""
    enabled = {entry.slug for entry in load_catalog().enabled()}
    registered = set(EXERCISE_BUILDERS)
    if enabled != registered:
        raise RuntimeError(
            "training adapter registry mismatch; "
            f"missing={sorted(enabled - registered)}, unknown={sorted(registered - enabled)}"
        )
    setup_registered = set(_SETUP_BUILDERS)
    if enabled != setup_registered:
        raise RuntimeError(
            "setup adapter registry mismatch; "
            f"missing={sorted(enabled - setup_registered)}, "
            f"unknown={sorted(setup_registered - enabled)}"
        )
    return tuple(sorted(registered))


def build_setup_adapter(exercise_id: str) -> SetupExerciseAdapter:
    builder = _SETUP_BUILDERS.get(exercise_id)
    if builder is None:
        raise KeyError(f"no setup adapter registered for '{exercise_id}'")
    return builder()


def build_training_adapter(
    exercise_id: str,
    *,
    baseline: dict,
    target: MovementTarget,
    config: ExerciseConfiguration | None = None,
    variant: str | None = None,
) -> TrainingAdapter:
    """``variant`` is the session plan's ("single" / "double" for curls), passed to exercises whose
    builder takes one."""
    builder = EXERCISE_BUILDERS.get(exercise_id)
    if builder is None:
        raise KeyError(f"no training adapter registered for '{exercise_id}'")
    selected_config = config or load_exercise_config(exercise_id)
    movement_type = selected_config.fsm.get("movement_type")
    if isinstance(target, RepTarget):
        if movement_type != "reps":
            raise ValueError("repetition target does not match the exercise movement type")
        extra = {"variant": variant} if variant and "variant" in signature(builder).parameters else {}
        return builder(baseline=baseline, target_reps=target.value, config=selected_config, **extra)
    if isinstance(target, TimeTarget):
        if movement_type != "time":
            raise ValueError("timed target does not match the exercise movement type")
        return builder(
            baseline=baseline,
            target_duration_ms=target.value_ms,
            config=selected_config,
        )
    raise TypeError("target must be a RepTarget or TimeTarget")
