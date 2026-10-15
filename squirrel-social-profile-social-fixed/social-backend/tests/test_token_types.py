"""Only user access tokens are people: Exercise's service tokens (typ "service") never provision a profile."""

from __future__ import annotations

from tests.conftest import make_token, new_sub


def test_access_and_untyped_tokens_are_accepted(client):
    for claims in ({"typ": "access"}, {}):
        r = client.get("/v1/users/me/profile", headers={"Authorization": f"Bearer {make_token(new_sub(), **claims)}"})
        assert r.status_code == 200, claims


def test_service_token_is_refused(client):
    token = make_token("exercise_module", typ="service")
    r = client.get("/v1/users/me/profile", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
    assert r.json()["code"] == "unauthorized"
