"""CORS_ALLOWED_ORIGINS: the web app on another domain may call the API; nobody else gets headers."""

from __future__ import annotations

import re

from fastapi import FastAPI

from backend.cors import add_cors, parse_allowed_origins
from backend.tests.asgi_client import call

APP_ORIGIN = "https://squirrel.vercel.app"


def _app(raw: str) -> FastAPI:
    app = FastAPI()

    @app.get("/api/ping")
    def ping():
        return {"ok": True}

    add_cors(app, raw)
    return app


def _preflight(app: FastAPI, origin: str):
    return call(app, "OPTIONS", "/api/ping", headers={
        "Origin": origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    })


def test_parse_exact_and_wildcard_origins():
    exact, regex = parse_allowed_origins(" https://app.example.com/ , ,https://sq-*-team.vercel.app")
    assert exact == ["https://app.example.com"]
    assert regex is not None
    assert re.fullmatch(regex, "https://sq-git-main-team.vercel.app")
    assert re.fullmatch(regex, "https://SQ-git-main-team.vercel.app")
    assert not re.fullmatch(regex, "https://sq-a.evil.com-team.vercel.app")
    assert not re.fullmatch(regex, "https://sq--team.vercel.app")
    assert parse_allowed_origins(None) == ([], None)


def test_allowed_origin_gets_preflight_and_headers():
    app = _app(f"{APP_ORIGIN},https://sq-*-team.vercel.app")
    res = _preflight(app, APP_ORIGIN)
    assert res.status == 200
    assert res.headers["access-control-allow-origin"] == APP_ORIGIN
    assert "authorization" in res.headers["access-control-allow-headers"].lower()
    assert "access-control-allow-credentials" not in res.headers

    res = call(app, "GET", "/api/ping", headers={"Origin": APP_ORIGIN})
    assert res.headers["access-control-allow-origin"] == APP_ORIGIN
    assert res.headers["access-control-expose-headers"] == "Retry-After"

    preview = "https://sq-git-saheb-team.vercel.app"
    assert _preflight(app, preview).headers["access-control-allow-origin"] == preview


def test_other_origins_get_no_cors_headers():
    app = _app(APP_ORIGIN)
    assert _preflight(app, "https://evil.example").status == 400
    res = call(app, "GET", "/api/ping", headers={"Origin": "https://evil.example"})
    assert res.status == 200
    assert "access-control-allow-origin" not in res.headers


def test_off_when_unset():
    app = _app("")
    res = call(app, "GET", "/api/ping", headers={"Origin": APP_ORIGIN})
    assert "access-control-allow-origin" not in res.headers
