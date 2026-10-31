"""Head-to-head challenges, the notification list, push tokens, territory steals from the Run
Module, and push delivery (sent only after commit; dead tokens disabled)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select, update

from app.models import Challenge, PushToken
from app.services.push import ExpoPush
from tests.conftest import auth, new_sub

SVC = {"Authorization": "Bearer svc-secret"}


def run(client, sub, ref, distance_m, started_at=None):
    body = {"user_subject": sub, "source": "run_module", "source_ref": ref, "type": "run", "distance_m": distance_m,
            "duration_s": 1500, "started_at": (started_at or datetime.now(timezone.utc)).isoformat()}
    assert client.post("/internal/v1/activities", json=body, headers=SVC).status_code in (200, 201)


def notes(client, sub) -> list[dict]:
    return client.get("/v1/notifications", headers=auth(sub)).json()["items"]


# --------------------------------------------------------------------------- challenges


def test_a_km_challenge_from_invite_to_winner(client, api, database):
    me, rival = new_sub(), new_sub()
    api.user(me)
    rival_id = api.user(rival)["id"]
    r = client.post("/v1/challenges", json={"opponent_id": rival_id, "metric": "km", "days": 7}, headers=auth(me))
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["status"] == "pending" and c["i_challenged"]
    assert notes(client, rival)[0]["kind"] == "challenge"

    assert client.post(f"/v1/challenges/{c['id']}/accept", headers=auth(me)).status_code == 403
    accepted = client.post(f"/v1/challenges/{c['id']}/accept", headers=auth(rival)).json()
    assert accepted["status"] == "accepted" and accepted["ends_at"]
    assert notes(client, me)[0]["kind"] == "challenge_accepted"

    run(client, me, "me-1", 8000)
    run(client, rival, "rival-1", 5000)
    run(client, me, "me-before", 30_000, started_at=datetime.now(timezone.utc) - timedelta(days=2))  # before it started
    live = client.get("/v1/challenges", headers=auth(me)).json()["items"][0]
    assert (live["me"]["score"], live["opponent"]["score"]) == (8.0, 5.0)

    with database.engine.begin() as conn:  # time passes
        conn.execute(update(Challenge).where(Challenge.id == uuid.UUID(c["id"]))
                     .values(ends_at=datetime.now(timezone.utc) + timedelta(seconds=1)))
    import time
    time.sleep(1.2)
    done = client.get("/v1/challenges", headers=auth(rival)).json()["items"][0]
    assert done["status"] == "finished" and done["winner_id"] != rival_id
    assert (done["me"]["score"], done["opponent"]["score"]) == (5.0, 8.0)
    assert notes(client, me)[0]["title"].startswith("You won")
    assert notes(client, rival)[0]["title"].startswith("You lost")


def test_challenge_rules(client, api):
    me, other = new_sub(), new_sub()
    me_id = api.user(me)["id"]
    other_id = api.user(other)["id"]
    assert client.post("/v1/challenges", json={"opponent_id": me_id}, headers=auth(me)).status_code == 422
    assert client.post("/v1/challenges", json={"opponent_id": str(uuid.uuid4())}, headers=auth(me)).status_code == 404
    assert client.post("/v1/challenges", json={"opponent_id": other_id, "days": 60}, headers=auth(me)).status_code == 422
    c = client.post("/v1/challenges", json={"opponent_id": other_id, "metric": "workouts", "days": 3}, headers=auth(me)).json()
    assert client.post(f"/v1/challenges/{c['id']}/decline", headers=auth(other)).json()["status"] == "declined"
    assert client.post(f"/v1/challenges/{c['id']}/accept", headers=auth(other)).status_code == 409
    c2 = client.post("/v1/challenges", json={"opponent_id": other_id}, headers=auth(me)).json()
    assert client.post(f"/v1/challenges/{c2['id']}/cancel", headers=auth(me)).json()["status"] == "cancelled"
    assert client.get(f"/v1/challenges", headers=auth(new_sub())).json()["items"] == []


# --------------------------------------------------------------------------- notifications


def test_list_page_and_mark_read(client, api):
    me = new_sub()
    me_id = api.user(me)["id"]
    fans = [new_sub() for _ in range(3)]
    for f in fans:
        client.post("/v1/challenges", json={"opponent_id": me_id}, headers=auth(f))
    page = client.get("/v1/notifications", params={"limit": 2}, headers=auth(me)).json()
    assert len(page["items"]) == 2 and page["unread"] == 3 and page["next_cursor"]
    rest = client.get("/v1/notifications", params={"cursor": page["next_cursor"]}, headers=auth(me)).json()
    assert len(rest["items"]) == 1
    assert page["items"][0]["actor"]["id"]
    first = page["items"][0]["id"]
    assert client.post("/v1/notifications/read", json={"ids": [first]}, headers=auth(me)).json() == {"unread": 2}
    assert client.post("/v1/notifications/read", json={}, headers=auth(me)).json() == {"unread": 0}
    assert client.get("/v1/notifications/unread-count", headers=auth(me)).json() == {"unread": 0}
    # someone else's list is theirs alone
    assert client.get("/v1/notifications", headers=auth(fans[0])).json()["items"] == []


def test_push_tokens_register_move_and_unregister(client, database):
    a, b = new_sub(), new_sub()
    token = "ExponentPushToken[abc123]"
    assert client.post("/v1/me/push-tokens", json={"token": "not-a-token", "platform": "ios"}, headers=auth(a)).status_code == 422
    assert client.post("/v1/me/push-tokens", json={"token": token, "platform": "ios"}, headers=auth(a)).status_code == 204
    assert client.post("/v1/me/push-tokens", json={"token": token, "platform": "ios"}, headers=auth(b)).status_code == 204
    b_id = client.get("/v1/users/me/profile", headers=auth(b)).json()["user"]["id"]
    with database.SessionLocal() as db:
        assert str(db.get(PushToken, token).user_id) == b_id
    assert client.delete(f"/v1/me/push-tokens/{token}", headers=auth(a)).status_code == 204  # not a's any more
    assert client.delete(f"/v1/me/push-tokens/{token}", headers=auth(b)).status_code == 204
    with database.SessionLocal() as db:
        assert db.get(PushToken, token) is None


def test_a_territory_steal_from_the_run_module_notifies_and_pushes_once(client, api, pushes):
    victim, thief = new_sub(), new_sub()
    api.user(victim)
    api.user(thief, display_name="Rhea")
    client.post("/v1/me/push-tokens", json={"token": "ExponentPushToken[victim]", "platform": "android"}, headers=auth(victim))
    body = {"user_subject": victim, "kind": "territory_lost", "actor_subject": thief,
            "data": {"area_delta_m2": 1234.4, "territory_id": "t-1", "capture_event_id": "ce-1"}, "dedupe_key": "ce-1:territory_lost"}
    assert client.post("/internal/v1/notifications", json=body).status_code == 401
    first = client.post("/internal/v1/notifications", json=body, headers=SVC).json()
    assert first["created"] is True
    retry = client.post("/internal/v1/notifications", json=body, headers=SVC).json()
    assert retry == {"created": False, "notification_id": first["notification_id"]}  # a retry: the same id
    [n] = notes(client, victim)
    assert n["id"] == first["notification_id"]
    assert n["title"] == "Rhea stole your territory" and n["body"] == "1,234 m² taken. Run it back!"
    assert n["data"]["route"] == "/territory" and n["actor"]["display_name"] == "Rhea"
    assert [p["to"] for p in pushes.sent] == ["ExponentPushToken[victim]"]
    assert pushes.sent[0]["data"]["kind"] == "territory_lost"


def test_a_steal_by_someone_blocked_either_way_never_names_them(client, api):
    victim, thief = new_sub(), new_sub()
    api.user(victim)
    thief_id = api.user(thief, display_name="Rhea")["id"]
    victim_id = api.me(victim)["user"]["id"]
    for blocker, blocked_id in ((thief, victim_id), (victim, thief_id)):  # the thief blocked them, then the reverse
        client.post(f"/v1/users/{blocked_id}/block", headers=auth(blocker))
        body = {"user_subject": victim, "kind": "territory_lost", "actor_subject": thief,
                "data": {"area_delta_m2": 1234.4, "territory_id": "t-1", "run_id": "r-1", "capture_event_id": "ce-1"},
                "dedupe_key": f"ce-{blocker}"}
        assert client.post("/internal/v1/notifications", json=body, headers=SVC).json()["created"] is True
        n = notes(client, victim)[0]
        assert n["title"] == "Someone stole your territory" and n["actor"] is None
        assert "Rhea" not in str(n) and "run_id" not in n["data"] and "capture_event_id" not in n["data"]
        assert n["data"]["territory_id"] == "t-1"
        client.delete(f"/v1/users/{blocked_id}/block", headers=auth(blocker))


def test_pushes_wait_for_commit_and_dead_tokens_are_disabled(database, pushes, client, api):
    me = new_sub()
    api.user(me)
    client.post("/v1/me/push-tokens", json={"token": "ExponentPushToken[dead]", "platform": "ios"}, headers=auth(me))
    client.post("/v1/me/push-tokens", json={"token": "ExponentPushToken[live]", "platform": "ios"}, headers=auth(me))

    def expo(request: httpx.Request) -> httpx.Response:
        sent = request.read()
        assert b"ExponentPushToken[dead]" in sent
        return httpx.Response(200, json={"data": [
            {"status": "error", "message": "gone", "details": {"error": "DeviceNotRegistered"}},
            {"status": "ok", "id": "x"},
        ]})

    sender = ExpoPush(database, client=httpx.Client(transport=httpx.MockTransport(expo)))
    sender.deliver([{"to": "ExponentPushToken[dead]", "title": "t"}, {"to": "ExponentPushToken[live]", "title": "t"}])
    with database.SessionLocal() as db:
        states = dict(db.execute(select(PushToken.token, PushToken.disabled_at)).all())
    assert states["ExponentPushToken[dead]"] is not None and states["ExponentPushToken[live]"] is None

    # A request that fails after queueing a push sends nothing.
    from app.services import notify, push
    with push.attach(database.SessionLocal(), pushes) as db:
        user_id = uuid.UUID(client.get("/v1/users/me/profile", headers=auth(me)).json()["user"]["id"])
        before = len(pushes.sent)
        notify.notify(db, user_id, "test", "Hello")
        db.rollback()
        assert len(pushes.sent) == before
        notify.notify(db, user_id, "test", "Hello")
        db.commit()
        assert [p["to"] for p in pushes.sent[before:]] == ["ExponentPushToken[live]"]
