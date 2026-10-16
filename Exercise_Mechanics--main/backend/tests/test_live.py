"""GET /api/live: open training sockets, counted per person."""

from __future__ import annotations

from backend import live
from backend.auth.tokens import issue_access_token
from backend.main import app
from backend.tests.asgi_client import call


def test_counts_people_training_now_not_sockets():
    token, _ = issue_access_token("11111111-1111-4111-8111-111111111111")
    headers = {"authorization": f"Bearer {token}"}
    assert call(app, "GET", "/api/live").status == 401
    before = call(app, "GET", "/api/live", headers=headers).json()["working_out_now"]
    with live.training("a"), live.training("a"), live.training("b"):
        assert call(app, "GET", "/api/live", headers=headers).json()["working_out_now"] == before + 2
    assert call(app, "GET", "/api/live", headers=headers).json()["working_out_now"] == before
