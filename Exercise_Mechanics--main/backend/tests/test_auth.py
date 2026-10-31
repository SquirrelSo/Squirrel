"""Auth REST — register / login / refresh and the bearer dependency."""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid

import pytest
from fastapi import Depends, FastAPI

from backend import config
from backend.auth import tokens
from backend.auth.deps import current_user
from backend.auth.router import router as auth_router
from backend.db import connection
from backend.tests.asgi_client import call
from backend.users.store import read_profile

_ACCOUNT = {"email": "Aanya@Example.test", "password": "correct horse", "first_name": "Aanya", "last_name": "Rao"}


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")
    monkeypatch.setattr(config, "AUTH_DIR", tmp_path / "auth")
    monkeypatch.setenv(config.AUTH_SECRET_ENV, "test-secret")
    app = FastAPI()
    app.include_router(auth_router)

    @app.get("/whoami")
    def whoami(user_id: str = Depends(current_user)) -> dict:
        return {"user_id": user_id}

    return app


def _bearer(token: str) -> dict:
    return {"authorization": f"Bearer {token}"}


def test_register_creates_profile_and_signs_in(app, tmp_path):
    r = call(app, "POST", "/api/auth/register", json=_ACCOUNT)
    assert r.status == 201
    body = r.json()
    profile = read_profile(body["user_id"])
    assert profile["email"] == "aanya@example.test" and profile["first_name"] == "Aanya"
    assert "password" not in json.dumps(profile)
    assert call(app, "GET", "/whoami", headers=_bearer(body["access_token"])).json() == {"user_id": body["user_id"]}
    # the plaintext password is never stored, and the file index never names the email
    if connection.enabled():
        with connection.pooled() as conn:
            [(stored,)] = conn.execute("SELECT password_hash FROM user_accounts").fetchall()
        assert stored.startswith("scrypt$") and "correct horse" not in stored
    else:
        [cred] = (tmp_path / "auth" / "credentials").iterdir()
        assert "aanya" not in cred.name and "correct horse" not in cred.read_text()


def test_duplicate_email_is_rejected_case_insensitively(app):
    assert call(app, "POST", "/api/auth/register", json=_ACCOUNT).status == 201
    dup = {**_ACCOUNT, "email": "aanya@EXAMPLE.test"}
    assert call(app, "POST", "/api/auth/register", json=dup).status == 409


def test_login_success_and_failure(app):
    uid = call(app, "POST", "/api/auth/register", json=_ACCOUNT).json()["user_id"]
    ok = call(app, "POST", "/api/auth/login", json={"email": "aanya@example.test", "password": "correct horse"})
    assert ok.status == 200 and ok.json()["user_id"] == uid
    bad = call(app, "POST", "/api/auth/login", json={"email": "aanya@example.test", "password": "wrong password"})
    assert bad.status == 401
    missing = call(app, "POST", "/api/auth/login", json={"email": "nobody@example.test", "password": "x"})
    assert missing.status == 401 and missing.json() == bad.json()


def test_refresh_rotates_and_is_single_use(app):
    first = call(app, "POST", "/api/auth/register", json=_ACCOUNT).json()
    second = call(app, "POST", "/api/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert second.status == 200 and second.json()["refresh_token"] != first["refresh_token"]
    replay = call(app, "POST", "/api/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert replay.status == 401


def test_bad_tokens_are_rejected(app):
    body = call(app, "POST", "/api/auth/register", json=_ACCOUNT).json()
    assert call(app, "GET", "/whoami").status == 401
    header, _payload, sig = body["access_token"].split(".")
    forged = tokens._b64e(json.dumps({"sub": "someone-else", "iat": 0, "exp": 9_999_999_999, "typ": "access"}).encode())
    assert call(app, "GET", "/whoami", headers=_bearer(f"{header}.{forged}.{sig}")).status == 401
    expired, _ = tokens.issue_access_token(body["user_id"], now=0)
    assert call(app, "GET", "/whoami", headers=_bearer(expired)).status == 401


def _part(obj: dict) -> str:
    return tokens._b64e(json.dumps(obj).encode())


def test_access_tokens_are_hs256_jwts_for_a_uuid(app):
    """The Run Module verifies these tokens itself: a standard HS256 JWT whose `sub` is a UUID."""
    body = call(app, "POST", "/api/auth/register", json=_ACCOUNT).json()
    header, payload, _sig = body["access_token"].split(".")
    assert json.loads(tokens._b64d(header)) == {"alg": "HS256", "typ": "JWT"}
    claims = json.loads(tokens._b64d(payload))
    assert claims["sub"] == body["user_id"] and claims["exp"] > claims["iat"]
    assert str(uuid.UUID(body["user_id"])) == body["user_id"] and uuid.UUID(body["user_id"]).version == 4


def test_unsigned_and_swapped_algorithm_tokens_are_rejected(app):
    body = call(app, "POST", "/api/auth/register", json=_ACCOUNT).json()
    _header, payload, sig = body["access_token"].split(".")
    unsigned = f"{_part({'alg': 'none', 'typ': 'JWT'})}.{payload}."
    swapped = f"{_part({'alg': 'HS512', 'typ': 'JWT'})}.{payload}.{sig}"
    for token in (unsigned, swapped, f"{payload}.{sig}", "not-a-token"):
        assert call(app, "GET", "/whoami", headers=_bearer(token)).status == 401, token


def test_the_run_modules_jwt_secret_is_the_fallback_key(app, monkeypatch):
    monkeypatch.delenv(config.AUTH_SECRET_ENV)
    monkeypatch.setenv(config.SHARED_JWT_SECRET_ENV, "shared-with-run-module")
    token, _ = tokens.issue_access_token("3f0c4b1e-6d0a-4b9a-9a55-2f7f1f8f6c11")
    header, payload, sig = token.split(".")
    expected = tokens._b64e(hmac.new(b"shared-with-run-module", f"{header}.{payload}".encode(), hashlib.sha256).digest())
    assert sig == expected
    monkeypatch.setenv(config.AUTH_SECRET_ENV, "explicit-wins")
    assert tokens.verify_access_token(token) is None  # SQUIRREL_AUTH_SECRET takes precedence


def test_password_hash_roundtrip():
    h = tokens.hash_password("s3cret-pass")
    assert tokens.verify_password("s3cret-pass", h)
    assert not tokens.verify_password("other", h)
    assert not tokens.verify_password("s3cret-pass", "garbage")
