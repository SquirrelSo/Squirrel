"""REST contract for creating the minimal session required by setup and training."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from backend.core.ids import is_valid_user_id
from backend.engine.loader import ConfigurationError, load_exercise_config
from backend.localtime import valid_zone
from backend.sessions.store import create_session_record
from backend.users.store import read_profile, read_skill
from backend.workouts.catalog import load_catalog

router = APIRouter(prefix="/api")


class SessionExercise(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    slug: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    variant: Literal["single", "double"] | None = None
    # Optional, what the person says they lift (kg per dumbbell). Recorded, never detected: the
    # pose model cannot see a weight.
    weight_kg: float | None = Field(default=None, gt=0, le=200)
    body_part: str = Field(min_length=1, max_length=80)
    training_tag: str = Field(min_length=1, max_length=80)
    measure: Literal["reps", "time"]
    sets: int = Field(ge=1, le=10)
    # Repetition plans are capped below in the exercise-aware branch; timed plans match the
    # existing 5–300 second frontend control without forcing fake rep limits onto duration.
    value: int = Field(ge=1, le=300)
    rest_seconds: int = Field(ge=0, le=300)


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # P1A deliberately persists one exercise. Multi-exercise sequencing is Stage 12.
    exercises: list[SessionExercise] = Field(min_length=1, max_length=1)
    # The phone's IANA time zone (e.g. "Asia/Kolkata"): the session's day and time follow it
    # (backend/localtime.py). Unknown names are ignored, never an error.
    timezone: str | None = Field(default=None, max_length=64)


class RepSessionTarget(BaseModel):
    type: Literal["reps"]
    value: int


class TimedSessionTarget(BaseModel):
    type: Literal["time"]
    value_ms: int


class SessionCreated(BaseModel):
    session_id: str
    exercise_id: str
    exercise_name: str
    variant: Literal["single", "double"] | None
    weight_kg: float | None = None
    sets: int
    target: RepSessionTarget | TimedSessionTarget
    rest_seconds: int


@router.post(
    "/users/{user_id}/sessions",
    response_model=SessionCreated,
    status_code=status.HTTP_201_CREATED,
)
def create_session(user_id: str, body: SessionCreate) -> dict:
    if not is_valid_user_id(user_id):
        raise HTTPException(status_code=400, detail="invalid user id")
    if read_profile(user_id) is None:
        raise HTTPException(status_code=404, detail="user not found")

    exercise = body.exercises[0]
    entry = load_catalog().get(exercise.slug)
    if entry is None:
        raise HTTPException(status_code=422, detail=f"unknown exercise: {exercise.slug}")
    if not entry.enabled:
        raise HTTPException(status_code=409, detail=f"exercise is planned and unavailable: {exercise.slug}")
    try:
        movement_type = load_exercise_config(exercise.slug).fsm["movement_type"]
    except (ConfigurationError, KeyError) as exc:
        raise HTTPException(status_code=422, detail="exercise configuration is unavailable") from exc
    if exercise.measure != movement_type:
        raise HTTPException(
            status_code=422,
            detail=f"exercise requires a {movement_type} target",
        )
    if movement_type == "reps" and exercise.value > 50:
        raise HTTPException(status_code=422, detail="repetition target cannot exceed 50")
    target = (
        {"type": "reps", "value": exercise.value}
        if exercise.measure == "reps"
        else {"type": "time", "value_ms": exercise.value * 1000}
    )

    plan = {
        "exercise_id": exercise.slug,
        "exercise_name": exercise.name,
        "variant": exercise.variant,
        "weight_kg": exercise.weight_kg,
        "sets": exercise.sets,
        "target": target,
        "rest_seconds": exercise.rest_seconds,
        "metadata": {
            "body_part": exercise.body_part,
            "training_tag": exercise.training_tag,
            "view": entry.view,
        },
    }
    skill_level, _ = read_skill(user_id)
    record = create_session_record(user_id, plan, skill_level, time_zone=valid_zone(body.timezone))
    return {"session_id": record["session_id"], **plan}
