"""Notification preferences (mute per category, quiet hours, push rate limit), mark-read routes,
the new internal kinds (CONTRACT §2), admin announcements, and the suggestions block filter."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.models import User
from tests.conftest import auth, new_sub

SVC = {"Authorization": "Bearer svc-secret"}
URL = "/internal/v1/notifications"
PREFS = "/v1/notifications/preferences"


def notes(client, sub) -> list[dict]:
    return client.get("/v1/notifications", headers=auth(sub)).json()["items"]


def meetup(user, key: str, **extra) -> dict:
    return {"user_subject": user, "kind": "meetup.invited", "title": "You're invited.", "data": {"meetup_id": "m-1"},
            "dedupe_key": key, **extra}


def with_device(client, api, sub, token="ExponentPushToken[dev]") -> str:
    uid = api.user(sub)["id"]
    assert client.post("/v1/me/push-tokens", json={"token": token, "platform": "ios"}, headers=auth(sub)).status_code == 204
    return uid


def make_admin(client, database, sub) -> None:
    client.get("/v1/users/me/profile", headers=auth(sub))
    with database.engine.begin() as conn:
        conn.execute(User.__table__.update().where(User.auth_subject == sub).values(role="admin"))


# --------------------------------------------------------------------------- preferences CRUD


def test_defaults_everything_on_and_system_not_mutable(client):
    me = new_sub()
    r = client.get(PREFS, headers=auth(me))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["categories"]) == {"xp", "challenges", "territory", "buddies", "workouts", "meetups", "bubble",
                                       "crews", "ambassador", "social", "system"}
    assert all(c["push"] and c["in_app"] for c in body["categories"].values())
    assert body["categories"]["system"]["mutable"] is False and body["categories"]["xp"]["mutable"] is True
    assert body["quiet_hours_start"] is None and body["timezone"] == "Asia/Kolkata" and body["updated_at"] is None


def test_patch_changes_only_what_is_sent(client):
    me = new_sub()
    r = client.patch(PREFS, json={"categories": {"social": {"push": False}}}, headers=auth(me))
    assert r.status_code == 200, r.text
    r = client.patch(PREFS, json={"categories": {"bubble": {"in_app": False}}, "quiet_hours_start": 1320,
                                  "quiet_hours_end": 420, "timezone": "Europe/London"}, headers=auth(me))
    body = r.json()
    assert body["categories"]["social"] == {"push": False, "in_app": True, "mutable": True}
    assert body["categories"]["bubble"] == {"push": True, "in_app": False, "mutable": True}
    assert (body["quiet_hours_start"], body["quiet_hours_end"], body["timezone"]) == (1320, 420, "Europe/London")
    # GET agrees; clearing quiet hours takes both nulls.
    assert client.get(PREFS, headers=auth(me)).json() == body
    body = client.patch(PREFS, json={"quiet_hours_start": None, "quiet_hours_end": None}, headers=auth(me)).json()
    assert body["quiet_hours_start"] is None and body["categories"]["social"]["push"] is False


def test_patch_validation(client):
    me = new_sub()
    bad = [
        {"categories": {"nope": {"push": False}}},
        {"categories": {"social": {"push": "no"}}},
        {"quiet_hours_start": 60},
        {"quiet_hours_start": 60, "quiet_hours_end": None},
        {"quiet_hours_start": 60, "quiet_hours_end": 60},
        {"quiet_hours_start": -1, "quiet_hours_end": 60},
        {"quiet_hours_start": 60, "quiet_hours_end": 1440},
        {"timezone": "Mars/Olympus"},
        {"unknown": True},
    ]
    for body in bad:
        r = client.patch(PREFS, json=body, headers=auth(me))
        assert r.status_code == 422, (body, r.text)
    r = client.patch(PREFS, json={"categories": {"system": {"in_app": False}}}, headers=auth(me))
    assert r.status_code == 422 and r.json()["code"] == "not_mutable"
    r = client.patch(PREFS, json={"categories": {"system": {"push": False}}}, headers=auth(me))
    assert r.status_code == 422
    assert client.get(PREFS, headers=auth(me)).json()["updated_at"] is None  # nothing stored


def test_preferences_need_auth(client):
    assert client.get(PREFS).status_code == 401
    assert client.patch(PREFS, json={}).status_code == 401


# --------------------------------------------------------------------------- delivery rules


def test_muted_in_app_category_stores_nothing(client, api, pushes):
    me = new_sub()
    with_device(client, api, me)
    client.patch(PREFS, json={"categories": {"meetups": {"in_app": False}}}, headers=auth(me))
    r = client.post(URL, json=meetup(me, "k1"), headers=SVC)
    assert r.status_code == 200 and r.json() == {"created": False, "notification_id": None}
    assert notes(client, me) == [] and pushes.sent == []
    # Other categories still arrive.
    body = {"user_subject": me, "kind": "partner.accepted", "title": "Matched!", "dedupe_key": "p1"}
    assert client.post(URL, json=body, headers=SVC).json()["created"] is True
    assert [n["kind"] for n in notes(client, me)] == ["partner.accepted"]


def test_push_off_keeps_in_app(client, api, pushes):
    me = new_sub()
    with_device(client, api, me)
    client.patch(PREFS, json={"categories": {"meetups": {"push": False}}}, headers=auth(me))
    assert client.post(URL, json=meetup(me, "k1"), headers=SVC).json()["created"] is True
    assert len(notes(client, me)) == 1 and pushes.sent == []


def test_quiet_hours_suppress_push_but_keep_in_app(client, api, pushes):
    me = new_sub()
    with_device(client, api, me)
    now = datetime.now(timezone.utc)
    minute = now.hour * 60 + now.minute
    client.patch(PREFS, json={"quiet_hours_start": (minute - 60) % 1440, "quiet_hours_end": (minute + 60) % 1440,
                              "timezone": "UTC"}, headers=auth(me))
    assert client.post(URL, json=meetup(me, "k1"), headers=SVC).json()["created"] is True
    assert len(notes(client, me)) == 1 and pushes.sent == []
    # Outside the window: pushed again.
    client.patch(PREFS, json={"quiet_hours_start": (minute + 120) % 1440, "quiet_hours_end": (minute + 180) % 1440},
                 headers=auth(me))
    client.post(URL, json=meetup(me, "k2"), headers=SVC)
    assert len(pushes.sent) == 1


def test_quiet_hours_window_wraps_midnight():
    from app.models import NotificationPreference
    from app.services.notify import in_quiet_hours

    pref = NotificationPreference(quiet_hours_start=22 * 60, quiet_hours_end=7 * 60, timezone="UTC")
    at = lambda h, m=0: datetime(2026, 10, 7, h, m, tzinfo=timezone.utc)  # noqa: E731
    assert in_quiet_hours(pref, at(23)) and in_quiet_hours(pref, at(3)) and in_quiet_hours(pref, at(22))
    assert not in_quiet_hours(pref, at(7)) and not in_quiet_hours(pref, at(12))
    assert not in_quiet_hours(None, at(23))


def test_system_ignores_mutes(client, api, database):
    me, admin = new_sub(), new_sub()
    api.user(me)
    make_admin(client, database, admin)
    # A stored mute for system (e.g. written before the rule) is ignored too.
    from sqlalchemy import select, update

    from app.models import NotificationPreference
    client.patch(PREFS, json={"categories": {"social": {"in_app": False}}}, headers=auth(me))
    with database.engine.begin() as conn:
        uid = conn.scalar(select(User.id).where(User.auth_subject == me))
        conn.execute(update(NotificationPreference).where(NotificationPreference.user_id == uid)
                     .values(categories={"system": {"in_app": False, "push": False}}))
    r = client.post("/v1/admin/announcements", json={"title": "Maintenance tonight", "body": "Back by 2."}, headers=auth(admin))
    assert r.status_code == 201, r.text
    assert [n["kind"] for n in notes(client, me)] == ["system.announcement"]


def test_push_rate_limit_per_recipient_and_category(client, api, pushes):
    me, other = new_sub(), new_sub()
    with_device(client, api, me)
    with_device(client, api, other, token="ExponentPushToken[other]")
    for i in range(9):
        assert client.post(URL, json=meetup(me, f"k{i}"), headers=SVC).json()["created"] is True
    assert len(notes(client, me)) == 9  # all stored in-app
    assert len(pushes.sent) == 6        # only 6 pushed in the hour
    # Another category, and another recipient, have their own budget.
    client.post(URL, json={"user_subject": me, "kind": "partner.accepted", "title": "Matched!", "dedupe_key": "p"}, headers=SVC)
    client.post(URL, json=meetup(other, "o1"), headers=SVC)
    assert len(pushes.sent) == 8


def test_dedupe_and_never_the_actor(client, api, pushes):
    me = new_sub()
    with_device(client, api, me)
    first = client.post(URL, json=meetup(me, "same"), headers=SVC).json()
    again = client.post(URL, json=meetup(me, "same"), headers=SVC).json()
    assert again == {"created": False, "notification_id": first["notification_id"]}
    assert len(notes(client, me)) == 1 and len(pushes.sent) == 1



def test_never_notifies_the_actor(api, database):
    from app.services import notify as notifications

    me = new_sub()
    uid = uuid.UUID(api.user(me)["id"])
    with database.SessionLocal() as db:
        assert notifications.notify(db, uid, "like", "You liked your own post", actor_id=uid) == 0
        assert notifications.notify(db, [uid], "like", "Someone liked your post", actor_id=uuid.uuid4()) == 1
        db.rollback()


# --------------------------------------------------------------------------- read routes


def test_mark_one_read_only_own(client, api):
    me, other = new_sub(), new_sub()
    api.user(me)
    api.user(other)
    a = client.post(URL, json=meetup(me, "a"), headers=SVC).json()["notification_id"]
    client.post(URL, json=meetup(me, "b"), headers=SVC)
    theirs = client.post(URL, json=meetup(other, "c"), headers=SVC).json()["notification_id"]
    r = client.post(f"/v1/notifications/{a}/read", headers=auth(me))
    assert r.status_code == 200 and r.json() == {"unread": 1}
    assert client.post(f"/v1/notifications/{a}/read", headers=auth(me)).json() == {"unread": 1}  # idempotent
    r = client.post(f"/v1/notifications/{theirs}/read", headers=auth(me))
    assert r.status_code == 404 and r.json()["code"] == "not_found"
    assert client.get("/v1/notifications/unread-count", headers=auth(other)).json() == {"unread": 1}
    assert client.post(f"/v1/notifications/{uuid.uuid4()}/read", headers=auth(me)).status_code == 404
    assert client.post("/v1/notifications/not-a-uuid/read", headers=auth(me)).status_code == 422
    assert client.post(f"/v1/notifications/{a}/read").status_code == 401


def test_read_all_and_legacy_read(client, api):
    me, other = new_sub(), new_sub()
    api.user(me)
    api.user(other)
    for k in ("a", "b", "c"):
        client.post(URL, json=meetup(me, k), headers=SVC)
    client.post(URL, json=meetup(other, "x"), headers=SVC)
    assert client.post("/v1/notifications/read-all", headers=auth(me)).json() == {"unread": 0}
    assert all(n["read"] for n in notes(client, me))
    assert client.get("/v1/notifications/unread-count", headers=auth(other)).json() == {"unread": 1}
    assert client.post("/v1/notifications/read", json={}, headers=auth(other)).json() == {"unread": 0}


# --------------------------------------------------------------------------- new internal kinds


def test_new_internal_kinds_with_their_routes(client, api):
    me = new_sub()
    api.user(me)
    cases = [
        ({"kind": "xp.level_up", "title": "Level 5!", "data": {"level": 5, "xp": 8000}}, "/progress", "xp"),
        ({"kind": "shared_workout.invited", "title": "{actor} invited you to work out", "data": {"code": "AB12CD", "session_id": "s-1"}},
         "/workout/join/AB12CD", "workouts"),
        ({"kind": "shared_workout.finished", "title": "Workout done", "data": {"session_id": "s-1"}}, "/workout/s-1", "workouts"),
        ({"kind": "shared_workout.invited", "title": "Odd code", "data": {"code": "../../x"}}, "/workout", "workouts"),
        ({"kind": "bubble.activity", "title": "Your bubble is moving", "data": {"zone_id": "z-1"}}, "/bubble", "bubble"),
    ]
    for i, (body, route, _category) in enumerate(cases):
        r = client.post(URL, json={"user_subject": me, "dedupe_key": f"k{i}", **body}, headers=SVC)
        assert r.status_code == 200, r.text
        assert r.json()["created"] is True
    by_title = {n["title"]: n for n in notes(client, me)}
    assert by_title["Level 5!"]["data"]["route"] == "/progress" and by_title["Level 5!"]["data"]["level"] == 5
    assert by_title["Someone invited you to work out"]["data"]["route"] == "/workout/join/AB12CD"
    assert by_title["Workout done"]["data"]["route"] == "/workout/s-1"
    assert by_title["Odd code"]["data"]["route"] == "/workout"
    assert by_title["Your bubble is moving"]["data"]["route"] == "/bubble"
    # Title is required for these kinds; partner.disconnected is not a kind.
    assert client.post(URL, json={"user_subject": me, "kind": "xp.level_up", "dedupe_key": "t"}, headers=SVC).status_code == 422
    assert client.post(URL, json={"user_subject": me, "kind": "partner.disconnected", "title": "x", "dedupe_key": "d"},
                       headers=SVC).status_code == 422


def test_bubble_activity_at_most_once_per_six_hours(client, api):
    me = new_sub()
    api.user(me)
    body = {"user_subject": me, "kind": "bubble.activity", "title": "Bubble"}
    assert client.post(URL, json={**body, "dedupe_key": "b1"}, headers=SVC).json()["created"] is True
    assert client.post(URL, json={**body, "dedupe_key": "b2"}, headers=SVC).json()["created"] is False
    assert len(notes(client, me)) == 1


def test_internal_kinds_respect_mutes_and_blocks(client, api):
    me, buddy = new_sub(), new_sub()
    api.user(me)
    buddy_id = api.user(buddy, display_name="Rhea")["id"]
    client.post(f"/v1/users/{buddy_id}/block", headers=auth(me))
    body = {"user_subject": me, "actor_subject": buddy, "kind": "shared_workout.invited", "title": "{actor} invited you",
            "actor_fallback": "A squirrel", "data": {"code": "Z1", "user_id": "u-9"}, "dedupe_key": "w1"}
    assert client.post(URL, json=body, headers=SVC).json()["created"] is True
    n = notes(client, me)[0]
    assert n["title"] == "A squirrel invited you" and n["actor"] is None and "user_id" not in n["data"]
    client.patch(PREFS, json={"categories": {"workouts": {"in_app": False}}}, headers=auth(me))
    assert client.post(URL, json={**body, "dedupe_key": "w2"}, headers=SVC).json()["created"] is False


# --------------------------------------------------------------------------- announcements


def test_announcement_reaches_everyone_once(client, api, database, pushes):
    admin = new_sub()
    users = [new_sub() for _ in range(3)]
    for u in users:
        with_device(client, api, u, token=f"ExponentPushToken[{u[:8]}]")
    make_admin(client, database, admin)
    r = client.post("/v1/admin/announcements", json={"title": "New season", "body": "Zones reset Monday.", "route": "/territory"},
                    headers=auth(admin))
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["recipients"] == 4  # the three users and the admin
    for u in users:
        [n] = notes(client, u)
        assert n["kind"] == "system.announcement" and n["data"]["route"] == "/territory"
        assert n["data"]["announcement_id"] == out["id"]
    assert len(pushes.sent) == 3
    # Re-running one announcement (same id) never notifies twice.
    from app.services import notify as notifications
    with database.SessionLocal() as db:
        assert notifications.announce(db, uuid.UUID(out["id"]), "New season", "", "/territory") == 0


def test_announcement_admin_only_validated_and_rate_limited(client, api, database):
    me, admin = new_sub(), new_sub()
    api.user(me)
    assert client.post("/v1/admin/announcements", json={"title": "x"}, headers=auth(me)).status_code == 403
    assert client.post("/v1/admin/announcements", json={"title": "x"}).status_code == 401
    make_admin(client, database, admin)
    for bad in ({}, {"title": ""}, {"title": "x" * 121}, {"title": "x", "route": "https://evil.test"}, {"title": "x", "extra": 1}):
        assert client.post("/v1/admin/announcements", json=bad, headers=auth(admin)).status_code == 422, bad
    codes = [client.post("/v1/admin/announcements", json={"title": f"n{i}"}, headers=auth(admin)).status_code for i in range(6)]
    assert codes == [201] * 5 + [429]


# --------------------------------------------------------------------------- suggestions


def test_suggestions_exclude_blocked_either_way(client, api):
    me, blocked_by_me, blocked_me, stranger = new_sub(), new_sub(), new_sub(), new_sub()
    api.user(me)
    a = api.user(blocked_by_me)["id"]
    b = api.user(blocked_me)["id"]
    c = api.user(stranger)["id"]
    me_id = api.me(me)["user"]["id"]
    assert client.post(f"/v1/users/{a}/block", headers=auth(me)).status_code == 200
    assert client.post(f"/v1/users/{me_id}/block", headers=auth(blocked_me)).status_code == 200
    ids = {u["id"] for u in client.get("/v1/users/suggestions", params={"limit": 20}, headers=auth(me)).json()["items"]}
    assert c in ids and a not in ids and b not in ids
