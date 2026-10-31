"""POST /internal/v1/people/resolve: token subjects / profile ids → Social names for another service."""

from __future__ import annotations

import dataclasses
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.main import create_app
from app.models import Member, User
from app.services.media import StoredObject
from tests.conftest import auth, new_sub

SVC = {"Authorization": "Bearer svc-secret"}
URL = "/internal/v1/people/resolve"


@pytest.fixture
def settings(settings):
    return dataclasses.replace(settings, hostels=("Hostel A", "Hostel B"))


def resolve(client, headers=SVC, **body):
    return client.post(URL, json=body, headers=headers)


def people(client, **body) -> list[dict]:
    r = resolve(client, **body)
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"people"}
    return r.json()["people"]


def _set_avatar(client, storage, sub) -> str:
    ticket = client.post("/v1/media/uploads", headers=auth(sub),
                         json={"purpose": "avatar", "content_type": "image/png", "byte_size": 1000}).json()
    storage.objects[storage.presigned[-1]] = StoredObject(byte_size=1000, content_type="image/png")
    client.post(f"/v1/media/{ticket['media_id']}/complete", headers=auth(sub))
    r = client.patch("/v1/users/me/profile", headers=auth(sub), json={"avatar_media_id": ticket["media_id"]})
    assert r.status_code == 200, r.text
    return r.json()["user"]["avatar_url"]


def test_resolve_existing_subject_with_profile_fields(api, client, storage, run_module):
    sub = new_sub()
    run_module.xp[sub] = 3 * 2000 + 10  # synced into user_stats on the next profile read
    user = api.user(sub, username="ria.runs", display_name="Ria", hostel="Hostel B")
    avatar = _set_avatar(client, storage, sub)
    assert avatar.startswith("https://cdn.test/")
    assert people(client, subjects=[sub]) == [{
        "subject": sub, "profile_id": user["id"], "username": "ria.runs", "display_name": "Ria",
        "avatar_url": avatar, "hostel": "Hostel B", "level": 4,
    }]


def test_resolve_defaults(api, client):
    sub = new_sub()
    user = api.user(sub)
    [p] = people(client, subjects=[sub])
    assert p["profile_id"] == user["id"] and p["profile_id"] != sub
    assert p["avatar_url"] is None and p["hostel"] is None and p["level"] == 1
    assert p["username"] == user["username"] and p["display_name"] == user["display_name"]


def test_unseen_subject_is_provisioned_like_a_first_sign_in(api, client, database):
    sub = new_sub()
    [p] = people(client, subjects=[sub])
    assert p["subject"] == sub and p["display_name"] == "New Squirrel" and p["username"].startswith("user_")
    assert p["level"] == 1 and p["avatar_url"] is None and p["hostel"] is None
    with database.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(User).where(User.auth_subject == sub)) == 1
        assert db.scalar(select(func.count()).select_from(Member)) == 0  # no waitlist row from a lookup
    # The same profile the person gets when they sign in, and again on a second lookup.
    assert api.me(sub)["user"]["id"] == p["profile_id"]
    assert people(client, subjects=[sub]) == [p]


def test_resolve_by_profile_id_and_unknown_ids_are_omitted(api, client):
    sub = new_sub()
    user = api.user(sub, username="kabir", display_name="Kabir")
    got = people(client, profile_ids=[str(uuid.uuid4()), user["id"]])
    assert got == [{"subject": sub, "profile_id": user["id"], "username": "kabir", "display_name": "Kabir",
                    "avatar_url": None, "hostel": None, "level": 1}]
    assert people(client, profile_ids=[str(uuid.uuid4())]) == []
    assert people(client) == []


def test_both_ways_with_dedup(api, client):
    a, b, c = new_sub(), new_sub(), new_sub()
    ua, ub = api.user(a), api.user(b)
    got = people(client, subjects=[a, c, a], profile_ids=[ub["id"], ua["id"], ub["id"], str(uuid.uuid4())])
    assert [p["subject"] for p in got] == [a, c, b]  # subjects first, in order, each person once
    assert [p["profile_id"] for p in got][0] == ua["id"] and got[2]["profile_id"] == ub["id"]
    assert len({p["profile_id"] for p in got}) == 3


def test_many_subjects_at_once(client):
    subs = [new_sub() for _ in range(200)]
    got = people(client, subjects=subs)
    assert [p["subject"] for p in got] == subs
    again = people(client, subjects=subs, profile_ids=[p["profile_id"] for p in got])
    assert again == got


def test_requires_service_token(client):
    body = {"subjects": [new_sub()]}
    assert client.post(URL, json=body).status_code == 401
    assert resolve(client, headers={"Authorization": "Bearer wrong"}, **body).status_code == 401
    # a user's JWT is not a service token
    sub = new_sub()
    assert resolve(client, headers=auth(sub), subjects=[sub]).status_code == 401


def test_not_found_without_internal_token(settings, database, run_module, storage, limiter, pushes):
    app = create_app(dataclasses.replace(settings, internal_token=None), database=database, run_module=run_module,
                     storage=storage, limiter=limiter, push=pushes)
    r = TestClient(app).post(URL, json={"subjects": ["x"]}, headers=SVC)
    assert r.status_code == 404


@pytest.mark.parametrize("body", [
    {"subjects": [new_sub() for _ in range(201)]},
    {"profile_ids": [str(uuid.uuid4()) for _ in range(201)]},
    {"profile_ids": ["not-a-uuid"]},
    {"subjects": [""]},
    {"subjects": ["x" * 256]},
    {"subjects": [42]},
    {"subjects": ["a"], "emails": ["a@b.c"]},
])
def test_validation(client, body):
    assert client.post(URL, json=body, headers=SVC).status_code == 422


def test_public_api_never_carries_the_subject(api, client):
    sub = new_sub()
    user = api.user(sub)
    people(client, subjects=[sub])
    r = client.get(f"/v1/users/{user['id']}/profile", headers=auth(new_sub()))
    assert r.status_code == 200 and sub not in r.text
    schema = client.get("/openapi.json")
    assert schema.status_code != 200 or URL not in schema.text
