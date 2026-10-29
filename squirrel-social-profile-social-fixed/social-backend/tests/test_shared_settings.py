"""Deployed next to the Exercise backend and the Run Module: their shared settings are read when
the SOCIAL_* ones are unset (app/config.py), and CORS takes the same `*` preview origins."""

from __future__ import annotations

import time

import jwt
import pytest
from fastapi.testclient import TestClient

from app.config import database_url_from_env, get_settings
from app.main import create_app, split_cors_origins

_SHARED = ("SOCIAL_DATABASE_URL", "DATABASE_URL", "SOCIAL_JWT_PUBLIC_KEY", "SOCIAL_JWT_PUBLIC_KEY_FILE",
           "SOCIAL_JWKS_URL", "SOCIAL_JWT_ALGORITHMS", "JWT_SECRET", "JWT_ALGORITHM",
           "SOCIAL_CORS_ORIGINS", "CORS_ALLOWED_ORIGINS")


@pytest.fixture
def env(monkeypatch):
    for name in _SHARED:
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield monkeypatch
    get_settings.cache_clear()


@pytest.mark.parametrize("raw,expected", [
    (None, False), ("", False), ("off", False), ("0", False), ("no", False), ("opne", False),
    ("on", True), ("1", True), ("true", True), (" Yes ", True),
])
def test_ambassador_applications_open_only_on_an_explicit_yes(env, raw, expected):
    env.setenv("JWT_SECRET", "s" * 40)  # any verifier config, so settings load
    if raw is None:
        env.delenv("SOCIAL_AMBASSADOR_OPEN", raising=False)
    else:
        env.setenv("SOCIAL_AMBASSADOR_OPEN", raw)
    assert get_settings().ambassador_open is expected


def test_plain_postgres_urls_get_the_psycopg_driver(env):
    env.setenv("DATABASE_URL", "postgresql://u:p%40ss@db.example:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/ca.crt")
    assert database_url_from_env() == (
        "postgresql+psycopg://u:p%40ss@db.example:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/ca.crt"
    )
    env.setenv("SOCIAL_DATABASE_URL", "postgres://other/db")
    assert database_url_from_env() == "postgresql+psycopg://other/db"


def test_the_shared_hs256_secret_verifies_exercise_backend_tokens(env, database):
    secret = "shared-secret-" + "x" * 40
    env.setenv("JWT_SECRET", secret)
    env.setenv("JWT_ALGORITHM", "HS256")
    settings = get_settings()
    assert settings.jwt_algorithms == ("HS256",)
    client = TestClient(create_app(settings, database=database))
    now = int(time.time())
    token = jwt.encode({"sub": "3f0c9a4e-1111-4222-8333-444455556666", "iat": now, "exp": now + 600}, secret, algorithm="HS256")
    assert client.get("/v1/users/me/profile", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    forged = jwt.encode({"sub": "someone-else", "iat": now, "exp": now + 600}, "wrong-secret-" + "y" * 40, algorithm="HS256")
    assert client.get("/v1/users/me/profile", headers={"Authorization": f"Bearer {forged}"}).status_code == 401


def test_an_explicit_public_key_wins_over_the_shared_secret(env):
    env.setenv("JWT_SECRET", "shared-secret-" + "x" * 40)
    env.setenv("SOCIAL_JWT_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----")
    settings = get_settings()
    assert settings.jwt_algorithms == ("RS256",)
    assert settings.jwt_public_key.startswith("-----BEGIN PUBLIC KEY-----\n")


def test_cors_reads_the_shared_origins_and_their_wildcards(env, database):
    env.setenv("JWT_SECRET", "shared-secret-" + "x" * 40)
    env.setenv("CORS_ALLOWED_ORIGINS", "https://squirrel-social.vercel.app, https://squirrel-*.vercel.app")
    settings = get_settings()
    exact, pattern = split_cors_origins(settings.cors_origins)
    assert exact == ["https://squirrel-social.vercel.app"]
    client = TestClient(create_app(settings, database=database))

    def allowed(origin: str) -> bool:
        r = client.options("/healthz", headers={"Origin": origin, "Access-Control-Request-Method": "GET"})
        return r.headers.get("access-control-allow-origin") == origin

    assert allowed("https://squirrel-social.vercel.app")
    assert allowed("https://squirrel-abc123-devsaheb-s-projects.vercel.app")
    assert not allowed("https://squirrel-x.evil.vercel.app.attacker.com")
    assert not allowed("https://evil.example")
