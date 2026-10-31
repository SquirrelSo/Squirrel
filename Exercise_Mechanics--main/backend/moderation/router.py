"""Report REST routes.

Members:
    POST  /api/users/{id}/reports                  file a report (201; 200 = already reported, under review)
    GET   /api/users/{id}/reports                  your own reports and their status

Moderators (Authorization: Bearer <MODERATION_TOKEN>):
    GET   /api/moderation/reports                  review queue; filter by status, category, reported_user_id
    GET   /api/moderation/reports/{report_id}      one report, with its full history
    PATCH /api/moderation/reports/{report_id}      set the status, with an optional note

There are no user accounts or roles yet, so moderator routes are protected by one shared token from
the MODERATION_TOKEN environment variable. Without it they refuse every request (503): an
unconfigured server never exposes who reported whom.
"""

from __future__ import annotations

import hmac
import os
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.core.ids import is_valid_user_id
from backend.moderation import policy, service
from backend.sessions.store import is_valid_session_id

router = APIRouter(prefix="/api")

Category = Literal[tuple(policy.CATEGORIES)]


class ReportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reported_user_id: str
    session_id: str | None = None   # set when the report is about one session (e.g. manipulated data)
    category: Category
    description: str | None = Field(default=None, max_length=policy.DESCRIPTION_MAX)
    source: Literal[policy.SOURCES] | None = None

    @field_validator("reported_user_id")
    @classmethod
    def _user(cls, value: str) -> str:
        if not is_valid_user_id(value):
            raise ValueError("invalid user id")
        return value

    @field_validator("session_id")
    @classmethod
    def _session(cls, value: str | None) -> str | None:
        if value is not None and not is_valid_session_id(value):
            raise ValueError("invalid session id")
        return value

    @field_validator("description")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return (value.strip() or None) if value is not None else None

    @model_validator(mode="after")
    def _other_needs_words(self) -> ReportIn:
        if self.category == "other" and not self.description:
            raise ValueError("describe what happened when the category is 'other'")
        return self


class StatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal[policy.STATUSES]
    note: str | None = Field(default=None, max_length=policy.NOTE_MAX)


def _checked(user_id: str) -> str:
    if not is_valid_user_id(user_id):
        raise HTTPException(status_code=400, detail={"code": "invalid_user_id", "message": "Invalid user id."})
    return user_id


def _call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except service.ModerationError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc


def require_moderator(authorization: str | None = Header(default=None)) -> None:
    token = os.environ.get("MODERATION_TOKEN", "")
    if not token:
        raise HTTPException(status_code=503, detail={
            "code": "moderation_not_configured", "message": "Set MODERATION_TOKEN to enable moderation."})
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not given or not hmac.compare_digest(given.encode(), token.encode()):
        raise HTTPException(status_code=401, detail={"code": "unauthorized", "message": "Moderator token required."})


# ---------------------------------------------------------------- members

@router.post("/users/{user_id}/reports", status_code=201)
def post_report(user_id: str, body: ReportIn, response: Response) -> dict:
    report, created = _call(service.file_report, _checked(user_id), body.model_dump())
    if not created:
        response.status_code = 200
    return {"report": report, "already_reported": not created}


@router.get("/users/{user_id}/reports")
def get_my_reports(user_id: str) -> dict:
    return {"reports": _call(service.my_reports, _checked(user_id))}


# ---------------------------------------------------------------- moderators

@router.get("/moderation/reports", dependencies=[Depends(require_moderator)])
def get_queue(status: Literal[policy.STATUSES] | None = None, category: Category | None = None,
              reported_user_id: str | None = None) -> dict:
    return service.review_queue(status=status, category=category, reported_user_id=reported_user_id)


@router.get("/moderation/reports/{report_id}", dependencies=[Depends(require_moderator)])
def get_one(report_id: str) -> dict:
    return {"report": _call(service.get_report, report_id)}


@router.patch("/moderation/reports/{report_id}", dependencies=[Depends(require_moderator)])
def patch_status(report_id: str, body: StatusIn) -> dict:
    return {"report": _call(service.update_status, report_id, body.status, body.note)}
