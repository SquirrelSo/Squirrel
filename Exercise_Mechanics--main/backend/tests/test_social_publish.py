"""Finished workouts are published to the Social service (backend/social_publish.py)."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from backend import social_publish

_ROW = {
    "id": "0b3c6f8e-0000-5000-8000-000000000001",
    "user_id": "3f0c9a4e-1111-4222-8333-444455556666",
    "subtype": "squat",
    "started_at": datetime(2026, 9, 28, 7, 0, tzinfo=timezone.utc),
    "duration_s": 540,
    "calories_kcal": None,
    "metrics": {"reps": 30, "correct_pct": 87.5, "avg_depth": None, "workout_score": 82,
                "sets": 3, "active_time_s": 240, "session_id": "sess_abc123"},
}


def test_payload_matches_the_social_contract():
    payload = social_publish.activity_payload(_ROW)
    assert payload == {
        "user_subject": _ROW["user_id"],
        "type": "workout",
        "source": "exercise",
        "source_ref": "sess_abc123",
        "started_at": "2026-09-28T07:00:00+00:00",
        "name": "Squats",
        "duration_s": 540,
        "calories": None,
        # Only short scalars go (Social refuses anything else); None values are left out.
        "metrics": {"reps": 30, "correct_pct": 87.5, "workout_score": 82, "sets": 3,
                    "active_time_s": 240, "session_id": "sess_abc123", "exercise": "squat"},
    }


def test_nothing_is_sent_without_both_settings(monkeypatch):
    monkeypatch.delenv("SOCIAL_API_URL", raising=False)
    monkeypatch.setenv("SOCIAL_INTERNAL_TOKEN", "svc")
    assert social_publish.publish(_ROW) is None
    monkeypatch.setenv("SOCIAL_API_URL", "http://social.test")
    assert social_publish.publish(None) is None


@pytest.fixture
def social_server():
    received: list[tuple[str, str, dict]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            received.append((self.path, self.headers["Authorization"], body))
            self.send_response(201 if len(received) == 1 else 500)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}", received
    server.shutdown()


def test_publishes_in_the_background_and_survives_a_failing_service(monkeypatch, social_server):
    url, received = social_server
    monkeypatch.setenv("SOCIAL_API_URL", url + "/")
    monkeypatch.setenv("SOCIAL_INTERNAL_TOKEN", "svc-secret")
    social_publish.publish(_ROW).join(5)
    social_publish.publish(_ROW).join(5)   # the service answers 500: logged, never raised
    assert [(path, auth) for path, auth, _ in received] == [("/internal/v1/activities", "Bearer svc-secret")] * 2
    assert received[0][2]["source_ref"] == "sess_abc123"
