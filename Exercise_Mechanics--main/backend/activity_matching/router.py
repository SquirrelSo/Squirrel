"""Activity-matching REST routes.

    GET  /api/users/{id}/activity-matching          status: what's missing, and what matches see
    GET  /api/users/{id}/activity-matches           members who share your activities, best first
    POST /api/users/{id}/activity-matches/blocks    block the member on a card: { card_id } (a Social block, ADR-032)

A card names its member by an opaque, per-viewer `card_id` (backend/card_ids.py), never by the
account id, which spells the member's full name.

Opting in is the "matching" consent: POST /api/users/{id}/consents {"category": "matching", ...}.
Activities and their interest scores come from sign-up page 2 (PUT /api/users/{id}/details).
Errors carry a machine-readable `code` in `detail`.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from backend.activity_matching import service
from backend.core.ids import is_valid_user_id

router = APIRouter(prefix="/api")


class BlockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    card_id: str = Field(min_length=1, max_length=64)


def _checked(user_id: str) -> str:
    if not is_valid_user_id(user_id):
        raise HTTPException(status_code=400, detail={"code": "invalid_user_id", "message": "Invalid user id."})
    return user_id


def _call(function, *args):
    try:
        return function(*args)
    except service.ActivityMatchingError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc


@router.get("/users/{user_id}/activity-matching")
def get_status(user_id: str) -> dict:
    return _call(service.status, _checked(user_id))


@router.get("/users/{user_id}/activity-matches")
def get_matches(user_id: str) -> dict:
    return {"matches": _call(service.find_matches, _checked(user_id))}


@router.post("/users/{user_id}/activity-matches/blocks")
def post_block(user_id: str, body: BlockRequest) -> dict:
    _call(service.block, _checked(user_id), body.card_id)
    return {"blocked_card_id": body.card_id}
