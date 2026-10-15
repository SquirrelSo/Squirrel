"""Partner Hunt REST routes.

    GET  /api/users/{id}/partner-hunt              status: XP, gate, age, saved preferences, and `options`
                                                   (the form's vocabularies with labels, age range, min XP)
    PUT  /api/users/{id}/partner-hunt/preferences  save preferences (allowed while still locked)
    GET  /api/users/{id}/partner-hunt/matches      the board — only once every access check passes
    POST /api/users/{id}/partner-hunt/blocks       block someone, both directions, immediately (in Social)

Cards never carry an account id (it spells the member's full name): each carries a `card_id`, opaque
and per viewer (backend/card_ids.py), and the routes that act on a card take that.

    Connect (connect.py): anonymous until both say yes, then each gets the other's Social profile id
    GET    /api/users/{id}/partner-hunt/requests                       { incoming, outgoing, connections }
    POST   /api/users/{id}/partner-hunt/requests                       { card_id } → request (201)
    POST   /api/users/{id}/partner-hunt/requests/{request_id}/accept   → connection
    POST   /api/users/{id}/partner-hunt/requests/{request_id}/decline  → 204, silent
    DELETE /api/users/{id}/partner-hunt/requests/{request_id}          → 204, the sender takes it back
    DELETE /api/users/{id}/partner-hunt/connections/{request_id}       → 204, either side removes a buddy, silently

Errors carry a machine-readable `code` in `detail` (see service.py) so the client can say exactly
what stands between the user and the board.
"""

from __future__ import annotations

from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from typing import Literal

from backend.core.ids import is_valid_user_id
from backend.partners import connect, service
from backend.partners.policy import (
    ACTIVITIES,
    MAX_PARTNER_AGE,
    MIN_AGE,
    MODES,
    PARTNER_GENDERS,
    PARTNER_HUNT_MIN_XP,
    WORKOUT_TIMES,
)
from backend.partners.xp_gate import XPGate, xp_gate_from_env

router = APIRouter(prefix="/api")

Activity = Literal[ACTIVITIES]
WorkoutTime = Literal[WORKOUT_TIMES]
Mode = Literal[MODES]
PartnerGender = Literal[PARTNER_GENDERS]


class PartnerPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")

    visible: bool
    activities: list[Activity] = Field(min_length=1, max_length=len(ACTIVITIES))
    mode: Mode
    city: str | None = Field(default=None, max_length=60)
    preferred_times: list[WorkoutTime] = Field(min_length=1, max_length=len(WORKOUT_TIMES))
    # Empty means "no preference". Naming genders restricts the board to them, and also means users
    # who have not disclosed a gender will not appear — their gender cannot be confirmed.
    partner_genders: list[PartnerGender] = Field(default_factory=list, max_length=len(PARTNER_GENDERS))
    partner_age_min: int = Field(ge=MIN_AGE, le=MAX_PARTNER_AGE)
    partner_age_max: int = Field(ge=MIN_AGE, le=MAX_PARTNER_AGE)

    @field_validator("activities", "preferred_times", "partner_genders")
    @classmethod
    def _unique(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("values must not repeat")
        return values

    @model_validator(mode="after")
    def _consistent(self) -> "PartnerPreferences":
        if self.partner_age_min > self.partner_age_max:
            raise ValueError("partner_age_min cannot exceed partner_age_max")
        city = (self.city or "").strip()
        if self.mode == "remote":
            # Data minimisation: a remote-only user's location is never needed, so it is not kept.
            self.city = None
        elif not city:
            raise ValueError("a city is required to meet in person")
        else:
            self.city = city
        return self


class CardRequest(BaseModel):
    """Blocking and Connect name the member by the card_id on their card."""
    model_config = ConfigDict(extra="forbid")
    card_id: str = Field(min_length=1, max_length=64)


@lru_cache(maxsize=1)
def get_xp_gate() -> XPGate:
    """Built once per process from the environment (see xp_gate.xp_gate_from_env). Tests override
    this dependency rather than the environment."""
    return xp_gate_from_env()


@router.get("/users/{user_id}/partner-hunt")
def get_partner_status(user_id: str, gate: XPGate = Depends(get_xp_gate)) -> dict:
    return _call(service.partner_status, _checked(user_id), gate)


@router.put("/users/{user_id}/partner-hunt/preferences")
def put_partner_preferences(user_id: str, body: PartnerPreferences) -> dict:
    return _call(service.save_preferences, _checked(user_id), body.model_dump())


@router.get("/users/{user_id}/partner-hunt/matches")
def get_partner_matches(user_id: str, gate: XPGate = Depends(get_xp_gate)) -> dict:
    matches = _call(service.find_matches, _checked(user_id), gate)
    return {"min_xp": PARTNER_HUNT_MIN_XP, "matches": matches}


@router.post("/users/{user_id}/partner-hunt/blocks")
def post_partner_block(user_id: str, body: CardRequest) -> dict:
    _call(service.block_user, _checked(user_id), body.card_id)
    return {"blocked_card_id": body.card_id}


@router.get("/users/{user_id}/partner-hunt/requests")
def get_partner_requests(user_id: str) -> dict:
    return _call(connect.list_requests, _checked(user_id))


@router.post("/users/{user_id}/partner-hunt/requests", status_code=201)
def post_partner_request(user_id: str, body: CardRequest, gate: XPGate = Depends(get_xp_gate)) -> dict:
    return _call(connect.send_request, _checked(user_id), body.card_id, gate)


@router.post("/users/{user_id}/partner-hunt/requests/{request_id}/accept")
def post_accept_partner_request(user_id: str, request_id: str) -> dict:
    return _call(connect.accept, _checked(user_id), request_id)


@router.post("/users/{user_id}/partner-hunt/requests/{request_id}/decline", status_code=204)
def post_decline_partner_request(user_id: str, request_id: str) -> Response:
    _call(connect.decline, _checked(user_id), request_id)
    return Response(status_code=204)


@router.delete("/users/{user_id}/partner-hunt/requests/{request_id}", status_code=204)
def delete_partner_request(user_id: str, request_id: str) -> Response:
    _call(connect.withdraw, _checked(user_id), request_id)
    return Response(status_code=204)


@router.delete("/users/{user_id}/partner-hunt/connections/{request_id}", status_code=204)
def delete_partner_connection(user_id: str, request_id: str) -> Response:
    _call(connect.remove_connection, _checked(user_id), request_id)
    return Response(status_code=204)


def _checked(user_id: str) -> str:
    # Strict: unlike safe_user_id, never substitutes an anonymous id — writing someone's
    # preferences into a shared "_anonymous" directory would be worse than refusing.
    if not is_valid_user_id(user_id):
        raise HTTPException(status_code=400, detail={"code": "invalid_user_id", "message": "Invalid user id."})
    return user_id


def _call(function, *args):
    try:
        return function(*args)
    except service.PartnerHuntError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc
