"""Nearby discovery REST routes (all require `Authorization: Bearer <access token>`).

  • GET/PUT /api/nearby/settings        — opt-in switch (default OFF) + profile visibility.
  • POST /api/proximity/session         — open/extend a device session; returns rotating BLE ids.
  • POST /api/proximity/detection       — upload a batch of BLE sightings (buffered while offline).
  • POST /api/proximity/confirm         — status of one observed token: unknown / pending / confirmed.
  • GET  /api/nearby                    — the caller's live nearby relationships (the Nearby screen).
  • POST /api/nearby/connect            — send / accept a connection with a nearby person.
  • GET  /api/connections               — people the caller is connected with.
  • POST /api/notifications/nearby      — collect (and acknowledge) the pending nearby notification.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from backend.auth.deps import current_user
from backend.nearby import protocol as P
from backend.nearby import store
from backend.nearby.engine import Detection, ProximityEngine, Relationship, SessionError, get_engine, iso

router = APIRouter(prefix="/api")

_TOKEN_PATTERN = rf"^[0-9a-fA-F]{{{P.BLE_ID_BYTES * 2}}}$"
_SESSION_PATTERN = r"^[A-Za-z0-9_-]{8,64}$"


class SettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    show_profile: bool = False


class SessionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    platform: Literal["ios", "android"]
    device_session: str | None = Field(default=None, pattern=_SESSION_PATTERN)


class DetectionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    anonymous_device_token: str = Field(pattern=_TOKEN_PATTERN)
    timestamp: datetime
    approximate_signal_strength: int = Field(ge=-127, le=20)


class DetectionBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_session: str = Field(pattern=_SESSION_PATTERN)
    detections: list[DetectionIn] = Field(min_length=1, max_length=P.MAX_DETECTIONS_PER_UPLOAD)


class ConfirmBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_session: str = Field(pattern=_SESSION_PATTERN)
    anonymous_device_token: str = Field(pattern=_TOKEN_PATTERN)


class ConnectBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nearby_id: str = Field(min_length=8, max_length=64)


def _require_enabled(user_id: str) -> None:
    if not store.is_enabled(user_id):
        raise HTTPException(status_code=403, detail="nearby discovery is turned off")


def _session_gone() -> HTTPException:
    # 409 tells the app to call POST /api/proximity/session again (expired, restarted server, …).
    return HTTPException(status_code=409, detail="unknown or expired device session")


def _epoch(ts: datetime) -> float:
    return (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)).timestamp()


def _card(rel: Relationship, viewer: str) -> dict:
    """What the viewer may see about a nearby person. Identity is shown only if they are already
    connected, or if the sighting is mutual AND the other person opted to show their profile."""
    other = rel.other(viewer)
    connection = store.connection_status(viewer, other)
    reveal = connection == "connected" or (rel.mutual and store.read_settings(other)["show_profile"])
    name = store.display_name(other) if reveal else None
    return {
        "nearby_id": rel.nearby_id,
        "proximity": rel.proximity,
        "confidence": rel.confidence,
        "mutual": rel.mutual,
        "first_detected": iso(rel.first_detected),
        "last_detected": iso(rel.last_detected),
        "expires_at": iso(rel.expires_at),
        "connection_status": connection,
        "profile": {"display_name": name} if name else None,
    }


# --- settings ----------------------------------------------------------------

@router.get("/nearby/settings")
def get_settings(user_id: str = Depends(current_user)) -> dict:
    return store.read_settings(user_id)


@router.put("/nearby/settings")
def put_settings(
    body: SettingsBody,
    user_id: str = Depends(current_user),
    engine: ProximityEngine = Depends(get_engine),
) -> dict:
    saved = store.write_settings(user_id, enabled=body.enabled, show_profile=body.show_profile)
    if not body.enabled:
        engine.forget_user(user_id)
    return saved


# --- proximity ---------------------------------------------------------------

@router.post("/proximity/session", status_code=status.HTTP_201_CREATED)
def open_session(
    body: SessionBody,
    user_id: str = Depends(current_user),
    engine: ProximityEngine = Depends(get_engine),
) -> dict:
    _require_enabled(user_id)
    return engine.open_session(user_id, body.platform, body.device_session)


@router.post("/proximity/detection")
def upload_detections(
    body: DetectionBatch,
    user_id: str = Depends(current_user),
    engine: ProximityEngine = Depends(get_engine),
) -> dict:
    _require_enabled(user_id)
    detections = [
        Detection(ble_id=d.anonymous_device_token.lower(), at=_epoch(d.timestamp), rssi=d.approximate_signal_strength)
        for d in body.detections
    ]
    try:
        return engine.ingest(user_id, body.device_session, detections)
    except SessionError:
        raise _session_gone() from None


@router.post("/proximity/confirm")
def confirm(
    body: ConfirmBody,
    user_id: str = Depends(current_user),
    engine: ProximityEngine = Depends(get_engine),
) -> dict:
    _require_enabled(user_id)
    try:
        return engine.confirm(user_id, body.device_session, body.anonymous_device_token.lower())
    except SessionError:
        raise _session_gone() from None


# --- nearby screen + connections ---------------------------------------------

@router.get("/nearby")
def list_nearby(user_id: str = Depends(current_user), engine: ProximityEngine = Depends(get_engine)) -> dict:
    if not store.is_enabled(user_id):
        return {"enabled": False, "count": 0, "nearby": []}
    cards = [_card(rel, user_id) for rel in engine.nearby_for(user_id)]
    return {"enabled": True, "count": len(cards), "nearby": cards}


@router.post("/nearby/connect")
def connect(
    body: ConnectBody,
    user_id: str = Depends(current_user),
    engine: ProximityEngine = Depends(get_engine),
) -> dict:
    _require_enabled(user_id)
    rel = engine.relationship(body.nearby_id, user_id)
    if rel is None:
        raise HTTPException(status_code=404, detail="this person is no longer nearby")
    store.request_connection(user_id, rel.other(user_id))
    return _card(rel, user_id)


@router.get("/connections")
def list_connections(user_id: str = Depends(current_user)) -> dict:
    return {"connections": [
        {"user_id": other, "display_name": store.display_name(other)} for other in store.connected_users(user_id)
    ]}


# --- notifications -----------------------------------------------------------

@router.post("/notifications/nearby")
def collect_nearby_notifications(
    user_id: str = Depends(current_user),
    engine: ProximityEngine = Depends(get_engine),
) -> dict:
    return {"notifications": engine.drain_notifications(user_id)}
