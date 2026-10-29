"""Crews (join, leave, vouch, member since), events (RSVP, capacity, reminders) and check-ins."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services import reminders
from tests.conftest import auth, new_sub


def crew(client, sub, name="Early Birds", **body) -> dict:
    r = client.post("/v1/crews", json={"name": name, "interest": "running", "tagline": "Up before the sun.",
                                      "meets": "Daily · 5:30 AM", **body}, headers=auth(sub))
    assert r.status_code == 201, r.text
    return r.json()


def soon(**delta) -> str:
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


def event(client, sub, **body) -> dict:
    body = {"title": "Lake loop 5K", "kind": "running", "venue": "Main gate", "starts_at": soon(days=1), **body}
    r = client.post("/v1/events", json=body, headers=auth(sub))
    assert r.status_code == 201, r.text
    return r.json()


def notes(client, sub) -> list[dict]:
    return client.get("/v1/notifications", headers=auth(sub)).json()["items"]


# --------------------------------------------------------------------------- crews


def test_create_join_and_list_crews(client, api):
    owner, member = new_sub(), new_sub()
    api.user(owner, username="owner1")
    c = crew(client, owner)
    assert c["members_count"] == 1 and c["my_role"] == "owner" and c["members"][0]["role"] == "owner"
    assert client.post("/v1/crews", json={"name": "early birds", "interest": "running"}, headers=auth(member)).status_code == 409

    joined = client.post(f"/v1/crews/{c['id']}/join", headers=auth(member)).json()
    assert joined["members_count"] == 2 and joined["is_member"] and joined["member_since"]
    # joining twice changes nothing
    assert client.post(f"/v1/crews/{c['id']}/join", headers=auth(member)).json()["members_count"] == 2

    listing = client.get("/v1/crews", headers=auth(member)).json()["items"]
    assert [x["name"] for x in listing] == ["Early Birds"] and len(listing[0]["preview"]) == 2
    assert client.get("/v1/crews", params={"mine": True}, headers=auth(new_sub())).json()["items"] == []
    assert client.get("/v1/crews", params={"q": "bird"}, headers=auth(member)).json()["items"][0]["id"] == c["id"]
    assert notes(client, owner)[0]["kind"] == "crew_join"


def test_vouching_and_member_since_show_on_the_profile(client):
    a, b, outsider = new_sub(), new_sub(), new_sub()
    c = crew(client, a)
    client.post(f"/v1/crews/{c['id']}/join", headers=auth(b))
    b_id = client.get("/v1/users/me/profile", headers=auth(b)).json()["user"]["id"]
    a_id = client.get("/v1/users/me/profile", headers=auth(a)).json()["user"]["id"]

    r = client.post(f"/v1/crews/{c['id']}/members/{b_id}/vouch", headers=auth(a))
    assert r.json() == {"vouches": 1, "vouched_by_me": True}
    assert client.post(f"/v1/crews/{c['id']}/members/{b_id}/vouch", headers=auth(a)).json()["vouches"] == 1
    assert client.post(f"/v1/crews/{c['id']}/members/{a_id}/vouch", headers=auth(a)).status_code == 422
    assert client.post(f"/v1/crews/{c['id']}/members/{b_id}/vouch", headers=auth(outsider)).status_code == 403

    profile = client.get(f"/v1/users/{b_id}/profile", headers=auth(outsider)).json()
    assert profile["crews"] == [{**profile["crews"][0], "name": "Early Birds", "role": "member", "vouches": 1}]
    assert profile["crews"][0]["member_since"]
    detail = client.get(f"/v1/crews/{c['id']}", headers=auth(a)).json()
    assert {m["user"]["id"]: m["vouches"] for m in detail["members"]}[b_id] == 1
    assert notes(client, b)[0]["kind"] == "vouch"

    assert client.delete(f"/v1/crews/{c['id']}/members/{b_id}/vouch", headers=auth(a)).json()["vouches"] == 0


def test_the_owner_leaving_hands_the_crew_on_and_the_last_one_out_deletes_it(client):
    a, b = new_sub(), new_sub()
    c = crew(client, a)
    client.post(f"/v1/crews/{c['id']}/join", headers=auth(b))
    assert client.delete(f"/v1/crews/{c['id']}/membership", headers=auth(a)).status_code == 204
    detail = client.get(f"/v1/crews/{c['id']}", headers=auth(b)).json()
    assert detail["members_count"] == 1 and detail["my_role"] == "owner"
    assert client.delete(f"/v1/crews/{c['id']}/membership", headers=auth(b)).status_code == 204
    assert client.get(f"/v1/crews/{c['id']}", headers=auth(b)).status_code == 404


# --------------------------------------------------------------------------- events


def test_an_open_event_with_rsvps_and_capacity(client):
    host, a, b = new_sub(), new_sub(), new_sub()
    e = event(client, host, capacity=2)
    assert e["going_count"] == 1 and e["my_rsvp"] == "going" and e["host"]["id"]
    assert client.post(f"/v1/events/{e['id']}/rsvp", json={"status": "going"}, headers=auth(a)).json()["going_count"] == 2
    full = client.post(f"/v1/events/{e['id']}/rsvp", json={"status": "going"}, headers=auth(b))
    assert full.status_code == 409 and full.json()["code"] == "event_full"
    assert client.post(f"/v1/events/{e['id']}/rsvp", json={"status": "interested"}, headers=auth(b)).json()["my_rsvp"] == "interested"
    left = client.delete(f"/v1/events/{e['id']}/rsvp", headers=auth(a)).json()
    assert left["going_count"] == 1 and left["my_rsvp"] is None

    upcoming = client.get("/v1/events", headers=auth(b)).json()["items"]
    assert [x["id"] for x in upcoming] == [e["id"]]
    assert [x["id"] for x in client.get("/v1/events", params={"scope": "mine"}, headers=auth(b)).json()["items"]] == [e["id"]]
    assert client.get("/v1/events", params={"scope": "mine"}, headers=auth(new_sub())).json()["items"] == []


def test_events_must_be_in_the_future_and_end_after_they_start(client):
    sub = new_sub()
    assert client.post("/v1/events", json={"title": "Too late", "kind": "running", "starts_at": soon(hours=-2)}, headers=auth(sub)).status_code == 422
    assert client.post("/v1/events", json={"title": "Backwards", "kind": "running", "starts_at": soon(hours=2),
                                           "ends_at": soon(hours=1)}, headers=auth(sub)).status_code == 422
    assert client.post("/v1/events", json={"title": "No zone", "kind": "running", "starts_at": "2030-01-01T06:00:00"},
                       headers=auth(sub)).status_code == 422


def test_a_crew_event_tells_the_crew_and_needs_a_member(client):
    owner, member, outsider = new_sub(), new_sub(), new_sub()
    c = crew(client, owner)
    client.post(f"/v1/crews/{c['id']}/join", headers=auth(member))
    assert client.post("/v1/events", json={"title": "Crew run", "kind": "running", "starts_at": soon(days=2), "crew_id": c["id"]},
                       headers=auth(outsider)).status_code == 403
    e = event(client, owner, title="Crew run", crew_id=c["id"])
    assert e["crew"]["name"] == "Early Birds"
    n = notes(client, member)[0]
    assert n["kind"] == "event_new" and n["data"]["route"] == f"/event/{e['id']}"
    assert [x["kind"] for x in notes(client, owner)] == ["crew_join"]  # the host is not told about their own event
    assert client.get(f"/v1/crews/{c['id']}", headers=auth(member)).json()["upcoming_events"][0]["id"] == e["id"]


def test_cancelling_tells_everyone_going(client):
    host, a = new_sub(), new_sub()
    e = event(client, host)
    client.post(f"/v1/events/{e['id']}/rsvp", json={"status": "going"}, headers=auth(a))
    assert client.delete(f"/v1/events/{e['id']}", headers=auth(a)).status_code == 403
    assert client.delete(f"/v1/events/{e['id']}", headers=auth(host)).status_code == 204
    assert notes(client, a)[0]["kind"] == "event_cancelled"
    assert client.get("/v1/events", headers=auth(a)).json()["items"] == []


def test_reminders_go_once_to_those_going(client, database, settings, pushes):
    host, a, b = new_sub(), new_sub(), new_sub()
    e = event(client, host, starts_at=soon(minutes=30))
    far = event(client, host, title="Next week", starts_at=soon(days=7))
    client.post(f"/v1/events/{e['id']}/rsvp", json={"status": "going"}, headers=auth(a))
    client.post(f"/v1/events/{e['id']}/rsvp", json={"status": "interested"}, headers=auth(b))
    with database.SessionLocal() as db:
        assert reminders.send_due(db, settings) == 1
        assert reminders.send_due(db, settings) == 0
    assert [n["kind"] for n in notes(client, a)] == ["event_reminder"]
    assert "starts in" in notes(client, a)[0]["title"]
    assert notes(client, b) == []
    assert [n["kind"] for n in notes(client, host)] == ["event_reminder"]
    assert far["id"] != e["id"]
    # the same task over HTTP, for a cron
    r = client.post("/internal/v1/tasks/event-reminders", headers={"Authorization": "Bearer svc-secret"})
    assert r.json() == {"reminded_events": 0}


# --------------------------------------------------------------------------- check-ins


def test_event_check_in_notifies_only_friends(client, api):
    me, follower, crewmate, stranger = new_sub(), new_sub(), new_sub(), new_sub()
    me_id = api.user(me)["id"]
    follower_id = api.user(follower)["id"]
    crewmate_id = api.user(crewmate)["id"]
    stranger_id = api.user(stranger)["id"]
    api.follow(follower, me_id)
    c = crew(client, me)
    client.post(f"/v1/crews/{c['id']}/join", headers=auth(crewmate))
    e = event(client, me, starts_at=soon(minutes=20))

    r = client.post(f"/v1/events/{e['id']}/checkin", json={"notify_user_ids": [follower_id, crewmate_id, stranger_id], "note": "At the gate"},
                    headers=auth(me))
    assert r.status_code == 201, r.text
    assert r.json()["notified"] == 2 and r.json()["place"] == "Main gate"
    assert notes(client, follower)[0]["title"].endswith("checked in at Main gate")
    assert [n["kind"] for n in notes(client, crewmate)] == ["checkin"]
    assert notes(client, stranger) == []
    # checking in again is the same check-in
    again = client.post(f"/v1/events/{e['id']}/checkin", json={}, headers=auth(me)).json()
    assert again["id"] == r.json()["id"]
    assert client.get(f"/v1/events/{e['id']}", headers=auth(me)).json()["checked_in"] is True


def test_check_in_opens_an_hour_before(client):
    sub = new_sub()
    e = event(client, sub, starts_at=soon(hours=3))
    r = client.post(f"/v1/events/{e['id']}/checkin", json={}, headers=auth(sub))
    assert r.status_code == 409 and r.json()["code"] == "checkin_closed"


def test_meetup_check_in_anywhere(client, api, pushes):
    me, friend = new_sub(), new_sub()
    me_id = api.user(me)["id"]
    friend_id = api.user(friend)["id"]
    api.follow(friend, me_id)
    client.post("/v1/me/push-tokens", json={"token": "ExponentPushToken[friendphone]", "platform": "android"}, headers=auth(friend))
    r = client.post("/v1/checkins", json={"place": "Library steps", "notify_user_ids": [friend_id]}, headers=auth(me))
    assert r.status_code == 201 and r.json()["notified"] == 1
    assert pushes.sent[-1]["to"] == "ExponentPushToken[friendphone]"
    assert pushes.sent[-1]["title"].endswith("checked in at Library steps")
