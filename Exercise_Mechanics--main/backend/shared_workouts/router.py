"""Shared workout routes. All need `Authorization: Bearer <access token>`; the socket takes the same
token in `?token=` (browsers can't set headers on a WebSocket, as with /ws/train).

    POST /api/workout-sessions                        { exercise_key, duration_s }  → Session (201)
    GET  /api/workout-sessions/{id}                                                 → Session
    GET  /api/workout-sessions/invites/{code}         preview before joining         → Session
    POST /api/workout-sessions/invites/{code}/join                                  → Session
    POST /api/workout-sessions/invites/{code}/decline an invited person says no    → 204
    PUT  /api/workout-sessions/{id}/ready             { ready }                      → Session
    POST /api/workout-sessions/{id}/reps              { reps, seq }                  → { accepted, reps, seq }
    POST /api/workout-sessions/{id}/complete          { reps, seq }                  → Session
    POST /api/workout-sessions/{id}/leave                                           → Session
    POST /api/workout-sessions/{id}/invite            { social_profile_id }  host, a buddy → Session
    POST /api/workout-sessions/{id}/cancel            host, lobby only                → Session
    WS   /ws/workout-sessions/{id}?token=…            workout.session.updated · workout.reps.updated ·
                                                      workout.session.invited · workout.session.cancelled ·
                                                      workout.session.completed · pong

Errors carry a machine-readable `code` in `detail` (service.py). The Session shape is model.view.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from starlette.concurrency import run_in_threadpool

from backend.auth.deps import current_user
from backend.auth.tokens import verify_access_token
from backend.core.ids import is_valid_user_id
from backend.shared_workouts import hub, presence, service
from backend.shared_workouts.policy import COMPLETION_SWEEP_S, DURATIONS_S, MAX_REPS, MAX_SEQ

log = logging.getLogger(__name__)

router = APIRouter()

SWEEP_INTERVAL_S = 1.0


class CreateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    exercise_key: str = Field(min_length=1, max_length=40)
    duration_s: Literal[DURATIONS_S]


class ReadyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ready: StrictBool


class RepsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reps: StrictInt = Field(ge=0, le=MAX_REPS)
    seq: StrictInt = Field(ge=1, le=MAX_SEQ)


class InviteBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    social_profile_id: str = Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


@router.post("/api/workout-sessions", status_code=201)
def create_session(body: CreateBody, user_id: str = Depends(current_user)) -> dict:
    return _call(service.create, user_id, body.exercise_key, body.duration_s)


@router.get("/api/workout-sessions/invites/{code}")
def preview_invite(code: str, user_id: str = Depends(current_user)) -> dict:
    return _call(service.preview, code, user_id)


@router.post("/api/workout-sessions/invites/{code}/join")
def join_invite(code: str, user_id: str = Depends(current_user)) -> dict:
    return _call(service.join, code, user_id)


@router.post("/api/workout-sessions/invites/{code}/decline", status_code=204)
def decline_invite(code: str, user_id: str = Depends(current_user)) -> Response:
    _call(service.decline_invite, code, user_id)
    return Response(status_code=204)


@router.get("/api/workout-sessions/{session_id}")
def get_session(session_id: str, user_id: str = Depends(current_user)) -> dict:
    return _call(service.get, session_id, user_id)


@router.put("/api/workout-sessions/{session_id}/ready")
def put_ready(session_id: str, body: ReadyBody, user_id: str = Depends(current_user)) -> dict:
    return _call(service.set_ready, session_id, user_id, body.ready)


@router.post("/api/workout-sessions/{session_id}/reps")
def post_reps(session_id: str, body: RepsBody, user_id: str = Depends(current_user)) -> dict:
    return _call(service.report_reps, session_id, user_id, body.reps, body.seq)


@router.post("/api/workout-sessions/{session_id}/complete")
def post_complete(session_id: str, body: RepsBody, user_id: str = Depends(current_user)) -> dict:
    return _call(service.complete, session_id, user_id, body.reps, body.seq)


@router.post("/api/workout-sessions/{session_id}/leave")
def post_leave(session_id: str, user_id: str = Depends(current_user)) -> dict:
    return _call(service.leave, session_id, user_id)


@router.post("/api/workout-sessions/{session_id}/invite")
def post_invite(session_id: str, body: InviteBody, user_id: str = Depends(current_user)) -> dict:
    return _call(service.invite, session_id, user_id, body.social_profile_id)


@router.post("/api/workout-sessions/{session_id}/cancel")
def post_cancel(session_id: str, user_id: str = Depends(current_user)) -> dict:
    return _call(service.cancel, session_id, user_id)


def _call(function, *args):
    try:
        return function(*args)
    except service.SharedWorkoutError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc


# --- the socket ------------------------------------------------------------------------------------

CLOSE_BAD_TOKEN = 4401
CLOSE_NOT_FOUND = 4404


@router.websocket("/ws/workout-sessions/{session_id}")
async def session_socket(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    token = websocket.query_params.get("token") or ""
    user_id = verify_access_token(token) if token else None
    if user_id is None or not is_valid_user_id(user_id):
        await websocket.close(code=CLOSE_BAD_TOKEN, reason="invalid or expired access token")
        return
    try:
        first, closed = await run_in_threadpool(service.socket_open, session_id, user_id)
    except service.SharedWorkoutError:
        await websocket.close(code=CLOSE_NOT_FOUND, reason="not found")
        return

    listener = hub.Listener(session_id, user_id, asyncio.get_running_loop())
    hub.add(listener)
    presence.socket_opened(session_id, user_id, service.utcnow())
    try:
        for message in first:
            await websocket.send_json(message)
        if closed:
            await websocket.close(code=1000)
            return
        _ensure_sweeper()
        reader = asyncio.create_task(_read(websocket, listener))
        writer = asyncio.create_task(_write(websocket, listener))
        done, pending = await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            task.result()
    finally:
        hub.remove(listener)
        presence.socket_closed(session_id, user_id, service.utcnow())


async def _read(websocket: WebSocket, listener: hub.Listener) -> None:
    """The app sends {"type": "ping"} every 10 s; anything else is ignored. Returns on disconnect."""
    while True:
        try:
            text = await websocket.receive_text()
        except WebSocketDisconnect:
            return
        try:
            message = json.loads(text)
        except ValueError:
            continue
        if isinstance(message, dict) and message.get("type") == "ping":
            listener.put(service.ping(listener.session_id, listener.user_id))


async def _write(websocket: WebSocket, listener: hub.Listener) -> None:
    while True:
        item = await listener.queue.get()
        if hub.CLOSE in item:
            await websocket.close(code=item[hub.CLOSE])
            return
        await websocket.send_json(item)


# The sweep: while any socket is open, each listened-to session is looked at every SWEEP_INTERVAL_S,
# so a phase reached by the clock alone (countdown → racing, the end, expiry) and a disconnected
# player reach the app without anyone calling a route.
_sweeper: asyncio.Task | None = None


def _ensure_sweeper() -> None:
    global _sweeper
    loop = asyncio.get_running_loop()
    if _sweeper is None or _sweeper.done() or _sweeper.get_loop() is not loop:
        _sweeper = loop.create_task(_sweep())


async def _sweep() -> None:
    signatures: dict[str, tuple | None] = {}
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_S)
        session_ids = hub.sessions()
        if not session_ids:
            return
        for session_id in session_ids:
            try:
                signatures[session_id] = await run_in_threadpool(service.tick, session_id, signatures.get(session_id))
            except Exception:  # noqa: BLE001 — one bad session (or a database blip) must not stop the sweep
                log.exception("shared workout sweep failed for %s", session_id)
        for gone in set(signatures) - set(session_ids):
            del signatures[gone]


# Settling races nobody is looking at: with no socket open the sweep above doesn't run, so a race
# whose players both closed the app would never be settled (no XP, no "finished" notification).
# This runs for the life of the app (started from main's lifespan) and settles every race whose
# last moment for rep reports has passed (service.finalise_due), once a COMPLETION_SWEEP_S.
async def completion_sweeper() -> None:
    while True:
        await asyncio.sleep(COMPLETION_SWEEP_S)
        try:
            await run_in_threadpool(service.finalise_due)
        except Exception:  # noqa: BLE001 — a database blip must not end the sweep
            log.exception("shared workout completion sweep failed")
