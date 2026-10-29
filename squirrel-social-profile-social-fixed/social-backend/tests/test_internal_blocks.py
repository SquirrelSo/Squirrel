"""GET /internal/v1/blocks/{subject} and POST /internal/v1/blocks/import: blocking for other services (ADR-032)."""

from __future__ import annotations

from sqlalchemy import func, select

import uuid

from app.models import Follow, User, UserBlock, UserStats
from tests.conftest import auth, new_sub

SVC = {"Authorization": "Bearer svc-secret"}


def blocks_of(client, sub, headers=SVC) -> list[str]:
    r = client.get(f"/internal/v1/blocks/{sub}", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"subject", "blocked", "as_of"} and body["subject"] == sub
    return body["blocked"]


def block(client, api, blocker, blocked):
    r = client.post(f"/v1/users/{api.me(blocked)['user']['id']}/block", headers=auth(blocker))
    assert r.status_code == 200, r.text


def test_both_directions_by_subject(api, client):
    me, i_blocked, blocked_me, stranger = (new_sub() for _ in range(4))
    for s in (me, i_blocked, blocked_me, stranger):
        api.user(s)
    block(client, api, me, i_blocked)
    block(client, api, blocked_me, me)
    assert sorted(blocks_of(client, me)) == sorted([i_blocked, blocked_me])
    assert blocks_of(client, i_blocked) == [me]
    assert blocks_of(client, blocked_me) == [me]
    assert blocks_of(client, stranger) == []


def test_unblock_shows_at_once(api, client):
    me, other = new_sub(), new_sub()
    api.user(me), api.user(other)
    block(client, api, me, other)
    assert blocks_of(client, other) == [me]
    client.delete(f"/v1/users/{api.me(other)['user']['id']}/block", headers=auth(me))
    assert blocks_of(client, other) == []


def test_unseen_subject_has_no_blocks_and_is_not_created(client, database):
    sub = new_sub()
    assert blocks_of(client, sub) == []
    with database.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(User).where(User.auth_subject == sub)) == 0


def test_service_token_required(client):
    sub = new_sub()
    assert client.get(f"/internal/v1/blocks/{sub}").status_code == 401
    assert client.get(f"/internal/v1/blocks/{sub}", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get(f"/internal/v1/blocks/{sub}", headers=auth(sub)).status_code == 401  # a user token is not a service token
    assert client.post("/internal/v1/blocks/import", json={"blocks": []}).status_code == 401


def test_import_copies_and_is_safe_to_rerun(api, client, database):
    a, b, c = new_sub(), new_sub(), new_sub()
    api.user(a), api.user(b)  # c has never opened Social
    block(client, api, a, b)
    body = {"blocks": [{"blocker": a, "blocked": b}, {"blocker": b, "blocked": c}, {"blocker": c, "blocked": c}]}
    r = client.post("/internal/v1/blocks/import", json=body, headers=SVC)
    assert r.status_code == 200, r.text
    assert r.json() == {"imported": 1, "already": 1, "skipped": 1}
    assert blocks_of(client, c) == [b]
    assert sorted(blocks_of(client, b)) == sorted([a, c])
    # Re-running changes nothing.
    assert client.post("/internal/v1/blocks/import", json=body, headers=SVC).json() == {"imported": 0, "already": 2, "skipped": 1}
    with database.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(UserBlock)) == 2
    # c got a profile, the one they get on signing in, and the block holds in the app.
    c_id = api.me(c)["user"]["id"]
    assert client.get(f"/v1/users/{api.me(b)['user']['id']}/block", headers=auth(c)).json()["blocked"] is False
    assert client.get(f"/v1/users/{c_id}/block", headers=auth(b)).json()["blocked"] is True


def test_import_removes_follows_like_an_app_block(api, client, database):
    a, b = new_sub(), new_sub()
    api.user(a), api.user(b)
    r = client.post(f"/v1/users/{api.me(b)['user']['id']}/follow", headers=auth(a))
    assert r.status_code == 200 and r.json()["following"], r.text
    r = client.post("/internal/v1/blocks/import", json={"blocks": [{"blocker": b, "blocked": a}]}, headers=SVC)
    assert r.json()["imported"] == 1
    with database.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Follow)) == 0
        assert db.get(UserStats, uuid.UUID(api.me(b)["user"]["id"])).followers_count == 0
