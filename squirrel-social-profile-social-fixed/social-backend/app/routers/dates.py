"""Squirrel Dates — suggestion only (services/dates.py).

  GET  /v1/dates/settings                         { enabled, zones_ready }
  PUT  /v1/dates/settings { enabled }             opt in (recent runs are scanned) / out (visits deleted)
  GET  /v1/dates/suggestions[?user_id=]           { available, enabled, reason, suggestions[] }
  POST /v1/dates/suggestions/{id}/dismiss         "Maybe later": not suggested again for 30 days

There is deliberately no invite endpoint: a suggestion tells the viewer who, where and when, and
nothing else happens. To meet, the viewer plans an event (POST /v1/events) like any other.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request, status

from app.deps import DB, AppSettings, CurrentViewer, Limiter, Storage
from app.errors import invalid, not_found
from app.models import User
from app.schemas_community import DatesSettings, DatesSettingsRequest, DateSuggestionOut, DateSuggestions, ZoneRef
from app.services import community
from app.services import dates as svc

router = APIRouter(prefix="/v1/dates", tags=["dates"])

NO_ZONES = "Squirrel Dates switches on once the campus zones are set up."
OFF = "Turn on Squirrel Dates to get suggestions for people who share your campus spots."


def _settings_out(db, viewer_id, settings) -> DatesSettings:
    return DatesSettings(enabled=svc.is_enabled(db, viewer_id), zones_ready=bool(settings.zones))


@router.get("/settings", response_model=DatesSettings)
def get_dates_settings(db: DB, viewer: CurrentViewer, settings: AppSettings):
    return _settings_out(db, viewer.id, settings)


@router.put("/settings", response_model=DatesSettings)
def put_dates_settings(body: DatesSettingsRequest, request: Request, db: DB, viewer: CurrentViewer, settings: AppSettings, limiter: Limiter):
    limiter.hit("dates:settings", str(viewer.id))
    svc.set_enabled(db, viewer.id, body.enabled, settings, request.app.state.route_points)
    db.commit()
    return _settings_out(db, viewer.id, settings)


@router.get("/suggestions", response_model=DateSuggestions)
def get_suggestions(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, user_id: uuid.UUID | None = None):
    enabled = svc.is_enabled(db, viewer.id)
    if not settings.zones:
        return DateSuggestions(available=False, enabled=enabled, reason=NO_ZONES, suggestions=[])
    if not enabled:
        return DateSuggestions(available=True, enabled=False, reason=OFF, suggestions=[])
    found = svc.suggestions(db, viewer.id, settings, only=user_id)
    people = community.summaries(db, [s.other_id for s in found], settings, storage)
    return DateSuggestions(available=True, enabled=True, reason=None, suggestions=[
        DateSuggestionOut(id=str(s.other_id), user=people[s.other_id], reason=s.reason,
                          zone=ZoneRef(id=s.zone.id, name=s.zone.name), suggested_time=s.suggested_time)
        for s in found if s.other_id in people
    ])


@router.post("/suggestions/{suggestion_id}/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_suggestion(suggestion_id: str, db: DB, viewer: CurrentViewer, limiter: Limiter):
    limiter.hit("dates:dismiss", str(viewer.id))
    try:
        other = uuid.UUID(suggestion_id)
    except ValueError:
        raise not_found("Suggestion not found.") from None
    if other == viewer.id:
        raise invalid("That's you.", "self_dismiss")
    if db.get(User, other) is None:
        raise not_found("Suggestion not found.")
    svc.dismiss(db, viewer.id, other)
    db.commit()
