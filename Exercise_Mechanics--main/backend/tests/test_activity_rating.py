"""Activity Rating: the member's own rating of a session, kept apart from the system Workout Score."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import FastAPI

from backend import config
from backend.activity_rating import store
from backend.activity_rating.router import router as rating_router
from backend.reports import builder
from backend.reports.router import router as reports_router
from backend.tests.test_workout_score import UID, _write_session


def _request(method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    app = FastAPI()
    app.include_router(rating_router)
    app.include_router(reports_router)
    body = json.dumps(payload).encode() if payload is not None else b""
    sent, messages = False, []

    async def receive() -> dict:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        messages.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
        "root_path": "", "headers": [(b"host", b"test"), (b"content-type", b"application/json")],
        "client": ("127.0.0.1", 12345), "server": ("test", 80),
    }
    asyncio.run(app(scope, receive, send))
    start = next(m for m in messages if m["type"] == "http.response.start")
    raw = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return start["status"], json.loads(raw)


SID = "20260920T090000-rate"
URL = f"/api/users/{UID}/sessions/{SID}/activity-rating"


@pytest.fixture(autouse=True)
def one_session(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path)
    _write_session(tmp_path, SID, "2026-09-20T09:00:00+00:00", [(100, 1.0), (70, 1.0), (100, 0.7), (90, 1.0)])


def test_an_unrated_session_reads_as_null():
    assert _request("GET", URL) == (200, {"activity_rating": None})


def test_rate_then_change_the_rating_keeping_when_it_was_first_rated():
    status, body = _request("PUT", URL, {"rating": 4, "feeling": "good", "effort": 7, "note": "  Legs felt heavy  "})
    assert status == 200
    first = body["activity_rating"]
    assert first["rating"] == 4 and first["feeling"] == "good" and first["effort"] == 7
    assert first["note"] == "Legs felt heavy"
    _, body = _request("PUT", URL, {"rating": 5})
    second = body["activity_rating"]
    assert second["rating"] == 5 and second["feeling"] is None and second["note"] is None
    assert second["rated_at"] == first["rated_at"]
    assert _request("GET", URL)[1]["activity_rating"]["rating"] == 5


def test_a_rating_can_be_removed():
    _request("PUT", URL, {"rating": 3})
    assert _request("DELETE", URL) == (200, {"deleted": True})
    assert _request("GET", URL)[1]["activity_rating"] is None
    assert _request("DELETE", URL) == (200, {"deleted": False})


@pytest.mark.parametrize("payload", [
    {}, {"rating": 0}, {"rating": 6}, {"rating": 3.5}, {"rating": 4, "effort": 11},
    {"rating": 4, "feeling": "ecstatic"}, {"rating": 4, "note": "x" * (store.NOTE_MAX + 1)},
    {"rating": 4, "workout_score": 100},
])
def test_invalid_ratings_are_refused(payload):
    assert _request("PUT", URL, payload)[0] == 422
    assert store.read_rating(UID, SID) is None


def test_only_an_existing_session_of_this_member_can_be_rated():
    assert _request("PUT", f"/api/users/{UID}/sessions/20260101T000000-none/activity-rating", {"rating": 4})[0] == 404
    assert _request("PUT", f"/api/users/someone-else-123456/sessions/{SID}/activity-rating", {"rating": 4})[0] == 404
    assert _request("PUT", f"/api/users/Bad_ID/sessions/{SID}/activity-rating", {"rating": 4})[0] == 400


def test_the_rating_sits_beside_the_workout_score_and_never_changes_it():
    before = builder.build_session_report(UID, SID)["workout_score"]
    _request("PUT", URL, {"rating": 1, "feeling": "bad", "effort": 10})
    report = builder.build_session_report(UID, SID)
    assert report["workout_score"] == before
    assert report["activity_rating"]["rating"] == 1
    assert "activity_rating" not in report["activity_metrics"]
    overview = builder.build_overview(UID, SID)
    assert overview["activity_rating"]["rating"] == 1 and overview["workout_score"] == before["score"]
    [session] = builder.build_progress(UID)["sessions"]
    assert session["activity_rating"] == 1 and session["workout_score"] == before["score"]


def test_a_corrupt_rating_file_reads_as_unrated():
    _request("PUT", URL, {"rating": 4})
    (config.user_dir(UID) / "sessions" / SID / store.RATING_FILENAME).write_text("{oops")
    assert _request("GET", URL)[1]["activity_rating"] is None
