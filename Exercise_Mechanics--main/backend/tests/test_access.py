"""Sign-in on the real app: every route that names a user serves only that signed-in user.

Covers the app-wide guard (auth/deps.require_path_user) over EVERY /api/users/{user_id}/... route,
sign-up with a password, filling in a coach profile on an account, and the development switch.
"""

from __future__ import annotations

import re
import uuid

import pytest

from backend import config
from backend.auth import tokens
from backend.tests.asgi_client import call

# main.py mounts the built web app; a fresh checkout that hasn't run `npm run build` has no folder.
(config._REPO_ROOT / "frontend-dist").mkdir(exist_ok=True)
from backend.main import app  # noqa: E402

_PAGE_ONE = {"first_name": "Ana", "last_name": "Tester", "gender": "female", "height_cm": 165,
             "weight_kg": 60, "date_of_birth": "1994-05-10", "mobile": "9990001111"}
_FILLERS = {"session_id": "20260101T000000-0000000000", "exercise_id": "squat", "year": "2026",
            "section": "fitness", "report_id": "rpt_0000000000000000"}


@pytest.fixture(autouse=True)
def _users(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")
    monkeypatch.setattr(config, "REPORTS_DIR", tmp_path / "reports")


def _bearer(token: str) -> dict:
    return {"authorization": f"Bearer {token}"}


def _sign_up(email: str) -> dict:
    res = call(app, "POST", "/api/users", json={**_PAGE_ONE, "email": email, "password": "correct horse"})
    assert res.status == 200, res.body
    return res.json()


def _user_routes() -> list[tuple[str, str]]:
    """Every (method, path) naming a user, read from the app's own API schema."""
    return [(method.upper(), path) for path, ops in app.openapi()["paths"].items() if "{user_id}" in path
            for method in ops]


def _fill(path: str, user_id: str) -> str:
    path = path.replace("{user_id}", user_id)
    return re.sub(r"\{(\w+)(?::\w+)?\}", lambda m: _FILLERS.get(m.group(1), "x"), path)


def test_the_guard_covers_every_per_user_route():
    routes = _user_routes()
    assert len(routes) >= 30  # profiles, sessions, reports, ratings, matching, partner hunt, reports…
    ana, bob = _sign_up("ana@example.test"), _sign_up("bob@example.test")
    for method, path in routes:
        url = _fill(path, ana["user_id"])
        assert call(app, method, url).status == 401, (method, path)
        refused = call(app, method, url, headers=_bearer(bob["access_token"]))
        assert refused.status == 403 and refused.json()["detail"] == "not your account", (method, path)
        # Her own token passes the guard. (A route may still say no for its own reasons, e.g. 403
        # "matching_consent_required", but never the guard's 401 or "not your account".)
        own = call(app, method, url, headers=_bearer(ana["access_token"]))
        assert own.status != 401 and "not your account" not in own.text, (method, path, own.status)


def test_routes_that_name_no_user_stay_public():
    assert call(app, "GET", "/api/exercises").status == 200
    assert call(app, "GET", "/api/activity-types").status == 200


def test_sign_up_needs_a_password_and_returns_tokens_for_a_uuid_account():
    no_password = call(app, "POST", "/api/users", json={**_PAGE_ONE, "email": "ana@example.test"})
    assert no_password.status == 422
    body = _sign_up("ana@example.test")
    assert str(uuid.UUID(body["user_id"])) == body["user_id"]
    assert tokens.verify_access_token(body["access_token"]) == body["user_id"] and body["refresh_token"]
    profile = call(app, "GET", f"/api/users/{body['user_id']}", headers=_bearer(body["access_token"])).json()
    assert profile["gender"] == "female" and profile["height_cm"] == 165 and "password" not in profile
    login = call(app, "POST", "/api/auth/login", json={"email": "ana@example.test", "password": "correct horse"})
    assert login.status == 200 and login.json()["user_id"] == body["user_id"]
    again = call(app, "POST", "/api/users", json={**_PAGE_ONE, "email": "ANA@example.test", "password": "other pass"})
    assert again.status == 409


def test_an_app_account_fills_in_its_coach_profile():
    account = call(app, "POST", "/api/auth/register", json={
        "email": "cara@example.test", "password": "correct horse", "first_name": "Cara", "last_name": "App"}).json()
    uid, auth = account["user_id"], _bearer(account["access_token"])
    details = {"gender": "male", "height_cm": 180, "weight_kg": 81, "date_of_birth": "1990-01-02", "mobile": "9876543210"}
    assert call(app, "PUT", f"/api/users/{uid}/profile", json={**details, "height_cm": 30}, headers=auth).status == 422
    saved = call(app, "PUT", f"/api/users/{uid}/profile", json=details, headers=auth)
    assert saved.status == 200, saved.body
    profile = call(app, "GET", f"/api/users/{uid}", headers=auth).json()
    assert profile["first_name"] == "Cara" and profile["gender"] == "male"
    assert profile["height_cm"] == 180 and profile["weight_kg"] == 81
    readings = call(app, "GET", f"/api/users/{uid}/measurements", headers=auth).json()
    assert len(readings["measurements"]) == 1  # recorded once, not twice
    other = _sign_up("dan@example.test")
    assert call(app, "PUT", f"/api/users/{uid}/profile", json=details, headers=_bearer(other["access_token"])).status == 403


def test_switching_auth_off_restores_the_password_less_browser_coach(monkeypatch):
    monkeypatch.setenv(config.REQUIRE_AUTH_ENV, "0")
    created = call(app, "POST", "/api/users", json={**_PAGE_ONE, "email": "old@example.test"})
    assert created.status == 200 and "access_token" not in created.json()
    assert call(app, "GET", f"/api/users/{created.json()['user_id']}").status == 200
