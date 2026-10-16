"""End-to-end nearby discovery over HTTP: two phones, opt-in, sightings, notification, connect."""

from __future__ import annotations

import time
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI

from backend import config
from backend.auth.router import router as auth_router
from backend.db import connection
from backend.nearby.engine import ProximityEngine, get_engine
from backend.nearby.router import router as nearby_router
from backend.tests.asgi_client import call


class Clock:
    def __init__(self):
        self.t = time.time()

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def app(tmp_path, monkeypatch, clock):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")
    monkeypatch.setattr(config, "AUTH_DIR", tmp_path / "auth")
    monkeypatch.setenv(config.AUTH_SECRET_ENV, "test-secret")
    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(nearby_router)
    engine = ProximityEngine(clock=clock)
    app.dependency_overrides[get_engine] = lambda: engine
    app.state.engine = engine
    return app


class Phone:
    def __init__(self, app, first: str, clock: Clock):
        self.app, self.clock = app, clock
        body = call(app, "POST", "/api/auth/register", json={
            "email": f"{first.lower()}@example.test", "password": "password123",
            "first_name": first, "last_name": "Tester"}).json()
        self.user_id = body["user_id"]
        self.headers = {"authorization": f"Bearer {body['access_token']}"}
        self.session: dict | None = None

    def req(self, method, path, json=None):
        return call(self.app, method, path, json=json, headers=self.headers)

    def enable(self, show_profile=False):
        r = self.req("PUT", "/api/nearby/settings", {"enabled": True, "show_profile": show_profile})
        assert r.status == 200

    def start(self):
        r = self.req("POST", "/api/proximity/session", {"platform": "android"})
        assert r.status == 201, r.text
        self.session = r.json()

    @property
    def advertised_id(self) -> str:
        now = datetime.fromtimestamp(self.clock.t, tz=timezone.utc).isoformat()
        return next(e["ble_id"] for e in self.session["ble_ids"] if e["valid_from"] <= now < e["valid_until"])

    def see(self, other: "Phone", rssi=-58):
        ts = datetime.fromtimestamp(self.clock.t, tz=timezone.utc).isoformat()
        return self.req("POST", "/api/proximity/detection", {
            "device_session": self.session["device_session"],
            "detections": [{"anonymous_device_token": other.advertised_id, "timestamp": ts,
                            "approximate_signal_strength": rssi}],
        })


def _sit(clock, a: Phone, b: Phone, *, mutual=False):
    for _ in range(3):
        assert a.see(b).status == 200
        if mutual:
            assert b.see(a).status == 200
        clock.t += 30


def test_nearby_is_opt_in(app, clock):
    a = Phone(app, "Aanya", clock)
    assert a.req("GET", "/api/nearby/settings").json() == {"enabled": False, "show_profile": False}
    assert a.req("POST", "/api/proximity/session", {"platform": "ios"}).status == 403
    assert a.req("GET", "/api/nearby").json() == {"enabled": False, "count": 0, "nearby": []}


def test_endpoints_require_auth(app):
    assert call(app, "GET", "/api/nearby").status == 401
    assert call(app, "POST", "/api/proximity/session", json={"platform": "ios"}).status == 401


def test_session_payload_contains_no_identity(app, clock):
    a = Phone(app, "Aanya", clock)
    a.enable()
    a.start()
    text = str(a.session).lower()
    assert "aanya" not in text and a.user_id not in text and "@" not in text


def test_full_flow_two_users(app, clock):
    a, b = Phone(app, "Aanya", clock), Phone(app, "Bilal", clock)
    for p in (a, b):
        p.enable()
        p.start()

    _sit(clock, a, b)

    # both get a generic notification with a deep link — no identity, no direction
    [na] = a.req("POST", "/api/notifications/nearby").json()["notifications"]
    [nb] = b.req("POST", "/api/notifications/nearby").json()["notifications"]
    for n in (na, nb):
        assert n["deep_link"] == "squirrelsocial://nearby"
        assert "Bilal" not in str(n) and "Aanya" not in str(n)

    # Nearby screen: anonymous card by default (one-sided sighting, no show_profile)
    nearby = a.req("GET", "/api/nearby").json()
    assert nearby["count"] == 1
    card = nearby["nearby"][0]
    assert card["profile"] is None and card["connection_status"] == "none"
    assert card["proximity"] == "very_close" and 0 < card["confidence"] <= 1

    # connect: A requests, B sees "incoming", B accepts → both connected and names revealed
    r = a.req("POST", "/api/nearby/connect", {"nearby_id": card["nearby_id"]})
    assert r.status == 200 and r.json()["connection_status"] == "requested"
    b_card = b.req("GET", "/api/nearby").json()["nearby"][0]
    assert b_card["connection_status"] == "incoming" and b_card["nearby_id"] == card["nearby_id"]
    r = b.req("POST", "/api/nearby/connect", {"nearby_id": card["nearby_id"]})
    assert r.json()["connection_status"] == "connected"
    assert r.json()["profile"] == {"display_name": "Aanya T."}
    assert a.req("GET", "/api/connections").json()["connections"] == [
        {"user_id": b.user_id, "display_name": "Bilal T."}]


def test_profile_revealed_only_when_mutual_and_opted_in(app, clock):
    a, b = Phone(app, "Aanya", clock), Phone(app, "Bilal", clock)
    a.enable()
    b.enable(show_profile=True)
    a.start()
    b.start()
    _sit(clock, a, b)
    assert a.req("GET", "/api/nearby").json()["nearby"][0]["profile"] is None   # one-sided
    b.see(a)
    assert a.req("GET", "/api/nearby").json()["nearby"][0]["profile"] == {"display_name": "Bilal T."}
    assert b.req("GET", "/api/nearby").json()["nearby"][0]["profile"] is None   # Aanya didn't opt in


def test_connect_requires_an_active_relationship(app, clock):
    a = Phone(app, "Aanya", clock)
    a.enable()
    assert a.req("POST", "/api/nearby/connect", {"nearby_id": "not-a-real-nearby-id"}).status == 404


def test_confirm_endpoint(app, clock):
    a, b = Phone(app, "Aanya", clock), Phone(app, "Bilal", clock)
    for p in (a, b):
        p.enable()
        p.start()
    body = {"device_session": a.session["device_session"], "anonymous_device_token": b.advertised_id}
    assert a.req("POST", "/api/proximity/confirm", body).json()["status"] == "pending"
    _sit(clock, a, b)
    body["anonymous_device_token"] = b.advertised_id
    confirmed = a.req("POST", "/api/proximity/confirm", body).json()
    assert confirmed["status"] == "confirmed" and "Bilal" not in str(confirmed)


def test_unknown_session_asks_client_to_reopen(app, clock):
    a = Phone(app, "Aanya", clock)
    a.enable()
    r = a.req("POST", "/api/proximity/detection", {
        "device_session": "stale-session-id",
        "detections": [{"anonymous_device_token": "ab" * 16, "timestamp": "2026-01-01T00:00:00Z",
                        "approximate_signal_strength": -60}]})
    assert r.status == 409


def test_malformed_detections_rejected(app, clock):
    a = Phone(app, "Aanya", clock)
    a.enable()
    a.start()
    bad = {"device_session": a.session["device_session"],
           "detections": [{"anonymous_device_token": "not-hex", "timestamp": "2026-01-01T00:00:00Z",
                           "approximate_signal_strength": -60}]}
    assert a.req("POST", "/api/proximity/detection", bad).status == 422


def test_turning_off_erases_proximity_and_stops_discovery(app, clock):
    a, b = Phone(app, "Aanya", clock), Phone(app, "Bilal", clock)
    for p in (a, b):
        p.enable()
        p.start()
    _sit(clock, a, b)
    old_id = b.advertised_id
    assert b.req("PUT", "/api/nearby/settings", {"enabled": False}).status == 200
    assert a.req("GET", "/api/nearby").json()["count"] == 0
    assert b.req("POST", "/api/notifications/nearby").json()["notifications"] == []
    r = a.req("POST", "/api/proximity/detection", {
        "device_session": a.session["device_session"],
        "detections": [{"anonymous_device_token": old_id,
                        "timestamp": datetime.fromtimestamp(clock.t, tz=timezone.utc).isoformat(),
                        "approximate_signal_strength": -50}]}).json()
    assert r["accepted"] == 0 and r["ignored"] == {"unknown": 1}
    assert app.state.engine.stats()["relationships"] == 0


def test_no_proximity_history_is_written_to_disk(app, clock, tmp_path):
    a, b = Phone(app, "Aanya", clock), Phone(app, "Bilal", clock)
    for p in (a, b):
        p.enable()
        p.start()
    _sit(clock, a, b, mutual=True)
    a.req("POST", "/api/notifications/nearby")
    written = sorted(p.name for p in (tmp_path / "users").rglob("*") if p.is_file())
    profiles = [] if connection.enabled() else ["profile.json", "profile.json"]  # in the database otherwise
    assert written == sorted(["nearby.json", "nearby.json", *profiles])
    for f in (tmp_path / "users").rglob("nearby.json"):
        assert b.user_id not in f.read_text() and a.user_id not in f.read_text()
