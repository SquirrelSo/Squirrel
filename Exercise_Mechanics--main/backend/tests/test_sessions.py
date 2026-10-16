"""Minimal session REST/storage contract and setup/train identity validation."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI

from backend import config
from backend.sessions import store as session_store
from backend.sessions.router import router as sessions_router
from backend.sessions.store import SessionAccessError, create_session_record, read_session_record, validate_session_access
from backend.training.router import _session_access
from backend.users.store import create_user_record

_PROFILE = {
    "first_name": "Session", "last_name": "Rig", "gender": "other",
    "height_cm": 180.0, "weight_kg": 75.0, "date_of_birth": "1990-01-01",
    "mobile": "1234567", "email": "session@example.test",
}


def _payload(slug: str = "squat") -> dict:
    return {
        "exercises": [{
            "name": "Squat" if slug == "squat" else "Bicep Curl",
            "slug": slug,
            "body_part": "Lower Body",
            "training_tag": "Strength",
            "measure": "reps",
            "sets": 3,
            "value": 8,
            "rest_seconds": 60,
        }],
    }


def _timed_high_knee_payload() -> dict:
    return {
        "exercises": [{
            "name": "High Knees",
            "slug": "high_knee",
            "body_part": "Full Body",
            "training_tag": "HIIT",
            "measure": "time",
            "sets": 2,
            "value": 30,
            "rest_seconds": 20,
        }],
    }


def _plan() -> dict:
    return {
        "exercise_id": "squat",
        "exercise_name": "Squat",
        "variant": None,
        "sets": 3,
        "target": {"type": "reps", "value": 8},
        "rest_seconds": 60,
        "metadata": {"body_part": "Lower Body", "training_tag": "Strength", "view": "front"},
    }


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(sessions_router)
    return app


def _post(app: FastAPI, path: str, payload: dict) -> tuple[int, dict]:
    """Small dependency-free ASGI client so the HTTP/Pydantic contract is genuinely exercised."""
    body = json.dumps(payload).encode()
    sent_request = False
    messages: list[dict] = []

    async def receive() -> dict:
        nonlocal sent_request
        if not sent_request:
            sent_request = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"test"), (b"content-type", b"application/json")],
        "client": ("127.0.0.1", 12345),
        "server": ("test", 80),
    }
    asyncio.run(app(scope, receive, send))
    start = next(message for message in messages if message["type"] == "http.response.start")
    response_body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], json.loads(response_body)


@pytest.fixture
def user_id(tmp_path, monkeypatch) -> str:
    monkeypatch.setattr(config, "USERS_DIR", tmp_path)
    return create_user_record(dict(_PROFILE))["user_id"]


def test_create_session_rest_persists_normalized_atomic_record(user_id):
    status, response = _post(_app(), f"/api/users/{user_id}/sessions", _payload())
    assert status == 201
    assert response == {
        "session_id": response["session_id"],
        "exercise_id": "squat",
        "exercise_name": "Squat",
        "variant": None,
        "weight_kg": None,
        "sets": 3,
        "target": {"type": "reps", "value": 8},
        "rest_seconds": 60,
    }
    record = read_session_record(user_id, response["session_id"])
    assert record is not None
    assert record["status"] == "created" and record["schema_version"] == 1
    assert record["plan"]["metadata"]["view"] == "front"
    session_dir = config.USERS_DIR / user_id / "sessions" / response["session_id"]
    assert [path.name for path in session_dir.iterdir()] == ["session.json"]


def test_repeated_starts_in_same_second_are_unique(user_id):
    frozen = datetime(2026, 7, 15, 12, 30, 0, tzinfo=timezone.utc)
    first = create_session_record(user_id, _plan(), "beginner", now=frozen)
    second = create_session_record(user_id, _plan(), "beginner", now=frozen)
    assert first["session_id"] != second["session_id"]
    assert read_session_record(user_id, first["session_id"])
    assert read_session_record(user_id, second["session_id"])


def test_normal_path_creates_a_timed_high_knee_session(user_id):
    status, response = _post(
        _app(),
        f"/api/users/{user_id}/sessions",
        _timed_high_knee_payload(),
    )
    assert status == 201
    assert response["exercise_id"] == "high_knee"
    assert response["target"] == {"type": "time", "value_ms": 30_000}
    access = validate_session_access(
        user_id,
        response["session_id"],
        "high_knee",
        "1",
    )
    assert access.exercise_id == "high_knee"


def test_atomic_write_failure_leaves_no_session_record(user_id, monkeypatch):
    def fail_write(*_args, **_kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(session_store, "_atomic_write_json", fail_write)
    with pytest.raises(OSError, match="disk unavailable"):
        create_session_record(user_id, _plan(), "beginner")
    sessions = config.USERS_DIR / user_id / "sessions"
    assert list(sessions.iterdir()) == []


@pytest.mark.parametrize(
    "user, payload, expected",
    [
        ("invalid!", _payload(), 400),
        ("missing-user", _payload(), 404),
        (None, _payload("lunge"), 409),
        (None, _payload("unknown_move"), 422),
    ],
)
def test_rest_rejects_invalid_user_or_unavailable_exercise(user_id, user, payload, expected):
    requested_user = user or user_id
    status, _ = _post(_app(), f"/api/users/{requested_user}/sessions", payload)
    assert status == expected


@pytest.mark.parametrize(
    "mutate",
    [
        lambda body: body["exercises"].append(dict(body["exercises"][0])),
        lambda body: body["exercises"][0].update(sets=0),
        lambda body: body["exercises"][0].update(value=0),
        lambda body: body["exercises"][0].update(value=51),
        lambda body: body["exercises"][0].update(rest_seconds=301),
        lambda body: body["exercises"][0].update(measure="time"),
    ],
)
def test_rest_rejects_invalid_plan(user_id, mutate):
    body = _payload()
    mutate(body)
    status, _ = _post(_app(), f"/api/users/{user_id}/sessions", body)
    assert status == 422


def test_session_access_requires_exact_session_exercise_and_set(user_id):
    record = create_session_record(user_id, _plan(), "beginner")
    sid = record["session_id"]
    access = validate_session_access(user_id, sid, "squat", "3")
    assert access.user_id == user_id and access.session_id == sid and access.set_no == 3

    cases = [
        (None, sid, "squat", "1", "invalid_user"),
        (user_id, None, "squat", "1", "invalid_session"),
        (user_id, "missing", "squat", "1", "session_not_found"),
        (user_id, sid, "high_knee", "1", "exercise_mismatch"),
        (user_id, sid, "squat", "0", "invalid_set"),
        (user_id, sid, "squat", "4", "invalid_set"),
    ]
    for uid, session_id, exercise, set_no, code in cases:
        with pytest.raises(SessionAccessError) as raised:
            validate_session_access(uid, session_id, exercise, set_no)
        assert raised.value.code == code


def test_websocket_identity_failure_is_explicit():
    class FakeWebSocket:
        query_params = {"user_id": "invalid!", "session_id": "sid", "exercise": "squat", "set_no": "1"}

        def __init__(self):
            self.messages: list[dict] = []
            self.closed: tuple[int, str] | None = None

        async def send_json(self, value: dict) -> None:
            self.messages.append(value)

        async def close(self, code: int, reason: str) -> None:
            self.closed = (code, reason)

    websocket = FakeWebSocket()
    assert asyncio.run(_session_access(websocket)) is None  # type: ignore[arg-type]
    assert websocket.messages == [{"error": {"code": "invalid_user", "detail": "a valid user_id is required"}}]
    assert websocket.closed == (1008, "invalid_user")


def test_the_phones_time_zone_is_kept_and_an_unknown_one_ignored(user_id):
    for zone, stored in (("Asia/Kolkata", "Asia/Kolkata"), ("Not/AZone", None), ("../etc", None)):
        status, response = _post(_app(), f"/api/users/{user_id}/sessions", {**_payload(), "timezone": zone})
        assert status == 201
        assert read_session_record(user_id, response["session_id"]).get("timezone") == stored


def test_an_optional_dumbbell_weight_is_recorded_with_the_plan(user_id):
    body = _payload("bicep_curl")
    body["exercises"][0]["weight_kg"] = 5
    status, response = _post(_app(), f"/api/users/{user_id}/sessions", body)
    assert status == 201 and response["weight_kg"] == 5
    assert read_session_record(user_id, response["session_id"])["plan"]["weight_kg"] == 5
    body["exercises"][0]["weight_kg"] = 0
    assert _post(_app(), f"/api/users/{user_id}/sessions", body)[0] == 422
