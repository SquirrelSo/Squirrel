"""/join + /invite routing, QR code, poster and Universal/App Link association files."""

from __future__ import annotations

import pytest
from fastapi import FastAPI

from backend import config
from backend.auth.router import router as auth_router
from backend.deeplinks.router import router as deeplinks_router
from backend.tests.asgi_client import call

ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")
    monkeypatch.setattr(config, "AUTH_DIR", tmp_path / "auth")
    monkeypatch.setattr(config, "INVITES_DIR", tmp_path / "invites")
    monkeypatch.setattr(config, "PUBLIC_BASE_URL", "https://squirrelsocial.app")
    monkeypatch.setattr(config, "PLAY_STORE_URL", "https://play.google.com/store/apps/details?id=app.squirrelsocial")
    monkeypatch.setattr(config, "APP_STORE_URL", "https://apps.apple.com/app/id123")
    monkeypatch.setenv(config.AUTH_SECRET_ENV, "test-secret")
    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(deeplinks_router)
    return app


def _get(app, path, ua):
    return call(app, "GET", path, headers={"user-agent": ua})


def test_join_routes_by_platform(app):
    android = _get(app, "/join", ANDROID)
    assert android.status == 302 and android.headers["location"] == config.PLAY_STORE_URL
    ios = _get(app, "/join", IPHONE)
    assert ios.status == 302 and ios.headers["location"] == config.APP_STORE_URL
    web = _get(app, "/join", DESKTOP)
    assert web.status == 200 and web.headers["content-type"].startswith("text/html")
    assert "People around you are already on Squirrel Social" in web.text
    assert "<svg" in web.text and "Life unscrolled" in web.text
    assert web.headers["vary"] == "User-Agent"


def _invite(app) -> dict:
    token = call(app, "POST", "/api/auth/register", json={
        "email": "aanya@example.test", "password": "password123",
        "first_name": "Aanya", "last_name": "Rao"}).json()["access_token"]
    r = call(app, "POST", "/api/invites", headers={"authorization": f"Bearer {token}"})
    assert r.status == 201
    return r.json()


def test_invite_link_carries_play_referrer_and_inviter_name(app):
    inv = _invite(app)
    assert inv["url"] == f"https://squirrelsocial.app/invite/{inv['token']}"
    android = _get(app, f"/invite/{inv['token']}", ANDROID)
    assert android.headers["location"].startswith(config.PLAY_STORE_URL + "&referrer=")
    assert inv["token"] in android.headers["location"]
    web = _get(app, f"/invite/{inv['token']}", DESKTOP)
    assert "Aanya R. invited you" in web.text and "aanya@example.test" not in web.text


def test_unknown_or_malicious_invite_falls_back_to_join(app):
    r = _get(app, "/invite/..%2F..%2Fetc%2Fpasswd", ANDROID)
    assert r.status == 302 and r.headers["location"] == config.PLAY_STORE_URL
    r = _get(app, "/invite/AAAAAAAAAAAAAAAAAAAA", DESKTOP)
    assert r.status == 200 and "invited you" not in r.text


def test_invites_require_auth(app):
    assert call(app, "POST", "/api/invites").status == 401


def test_qr_svg_and_poster(app):
    r = call(app, "GET", "/join/qr.svg")
    assert r.status == 200 and r.headers["content-type"] == "image/svg+xml"
    assert r.text.startswith("<svg")
    poster = call(app, "GET", "/join/poster")
    assert "Scan to join us" in poster.text and "SQUIRREL" in poster.text and "<svg" in poster.text


def test_app_link_association_files(app, monkeypatch):
    monkeypatch.setattr(config, "IOS_APP_IDS", ["ABCDE12345.app.squirrelsocial"])
    monkeypatch.setattr(config, "ANDROID_CERT_SHA256", ["AA:BB"])
    aasa = call(app, "GET", "/.well-known/apple-app-site-association").json()
    detail = aasa["applinks"]["details"][0]
    assert detail["appIDs"] == ["ABCDE12345.app.squirrelsocial"]
    assert {"/": "/join"} in detail["components"] and {"/": "/invite/*"} in detail["components"]
    [link] = call(app, "GET", "/.well-known/assetlinks.json").json()
    assert link["target"]["package_name"] == config.ANDROID_PACKAGE
    assert link["target"]["sha256_cert_fingerprints"] == ["AA:BB"]
