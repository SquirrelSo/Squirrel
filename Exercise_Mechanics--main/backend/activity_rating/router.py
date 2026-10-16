"""Activity Rating REST routes — the member rates a session they did.

    GET    /api/users/{id}/sessions/{sid}/activity-rating   the rating, or null when unrated
    PUT    /api/users/{id}/sessions/{sid}/activity-rating   rate it, or change the rating
    DELETE /api/users/{id}/sessions/{sid}/activity-rating   remove the rating

The Workout Score in the session report is system-generated and is not affected by any of these.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.activity_rating import store
from backend.core.ids import is_valid_user_id
from backend.db.exercise_sessions import sync_session
from backend.sessions.store import is_valid_session_id, read_session_record

router = APIRouter(prefix="/api")


class ActivityRatingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rating: int = Field(ge=store.RATING_MIN, le=store.RATING_MAX)
    feeling: Literal[store.FEELINGS] | None = None
    effort: int | None = Field(default=None, ge=store.EFFORT_MIN, le=store.EFFORT_MAX)
    note: str | None = Field(default=None, max_length=store.NOTE_MAX)

    @field_validator("note")
    @classmethod
    def _blank_note_is_none(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None


def _session(user_id: str, session_id: str) -> None:
    """Only the session's own member can rate it."""
    if not is_valid_user_id(user_id):
        raise HTTPException(status_code=400, detail={"code": "invalid_user_id", "message": "Invalid user id."})
    if not is_valid_session_id(session_id):
        raise HTTPException(status_code=400, detail={"code": "invalid_session_id", "message": "Invalid session id."})
    record = read_session_record(user_id, session_id)
    if record is None or record.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail={"code": "session_not_found", "message": "No such session."})


@router.get("/users/{user_id}/sessions/{session_id}/activity-rating")
def get_rating(user_id: str, session_id: str) -> dict:
    _session(user_id, session_id)
    return {"activity_rating": store.read_rating(user_id, session_id)}


@router.put("/users/{user_id}/sessions/{session_id}/activity-rating")
def put_rating(user_id: str, session_id: str, body: ActivityRatingIn) -> dict:
    _session(user_id, session_id)
    rating = store.write_rating(user_id, session_id, body.model_dump())
    sync_session(user_id, session_id)  # refresh the database row; a no-op without DATABASE_URL
    return {"activity_rating": rating}


@router.delete("/users/{user_id}/sessions/{session_id}/activity-rating")
def delete_rating(user_id: str, session_id: str) -> dict:
    _session(user_id, session_id)
    deleted = store.delete_rating(user_id, session_id)
    sync_session(user_id, session_id)
    return {"deleted": deleted}
