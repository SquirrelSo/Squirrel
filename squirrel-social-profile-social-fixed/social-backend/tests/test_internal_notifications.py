"""POST /internal/v1/notifications from campus-service and Exercise: their kinds, the caller's text with an
`{actor}` placeholder Social fills (or hides on a block), and Social's notification id back."""

from __future__ import annotations

from tests.conftest import auth, new_sub

SVC = {"Authorization": "Bearer svc-secret"}
URL = "/internal/v1/notifications"


def notes(client, sub) -> list[dict]:
    return client.get("/v1/notifications", headers=auth(sub)).json()["items"]


def campus(user, actor=None, **extra) -> dict:
    body = {"user_subject": user, "kind": "meetup.invited", "title": "{actor} invited you to a meetup.",
            "data": {"meetup_id": "m-1", "user_id": "campus-u-9"}, "dedupe_key": f"meetup.invited:m-1:{user}"}
    if actor:
        body["actor_subject"] = actor
    return {**body, **extra}


def test_a_campus_notification_names_the_actor_and_returns_socials_id(client, api, pushes):
    me, host = new_sub(), new_sub()
    api.user(me)
    api.user(host, display_name="Rhea")
    client.post("/v1/me/push-tokens", json={"token": "ExponentPushToken[me]", "platform": "ios"}, headers=auth(me))
    r = client.post(URL, json=campus(me, host, body="Tomorrow, {actor}'s pick."), headers=SVC)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["created"] is True and out["notification_id"]
    [n] = notes(client, me)
    assert n["id"] == out["notification_id"] and n["kind"] == "meetup.invited"
    assert n["title"] == "Rhea invited you to a meetup." and n["body"] == "Tomorrow, Rhea's pick."
    assert n["actor"]["display_name"] == "Rhea"
    assert n["data"]["route"] == "/meetup/m-1" and n["data"]["user_id"] == "campus-u-9"
    assert pushes.sent[-1]["title"] == "Rhea invited you to a meetup."
    assert pushes.sent[-1]["data"]["kind"] == "meetup.invited"
    # A retry lands once and answers with the same id.
    again = client.post(URL, json=campus(me, host, body="Tomorrow, {actor}'s pick."), headers=SVC).json()
    assert again == {"created": False, "notification_id": out["notification_id"]}
    assert len(notes(client, me)) == 1


def test_blocked_either_way_the_placeholder_becomes_the_fallback_and_actor_ids_go(client, api, pushes):
    me, host = new_sub(), new_sub()
    me_id = api.user(me)["id"]
    host_id = api.user(host, display_name="Rhea")["id"]
    client.post("/v1/me/push-tokens", json={"token": "ExponentPushToken[me]", "platform": "ios"}, headers=auth(me))
    for blocker, blocked_id in ((host, me_id), (me, host_id)):
        client.post(f"/v1/users/{blocked_id}/block", headers=auth(blocker))
        body = campus(me, host, kind="zone.claimed", title="{actor} claimed Main Quad.", actor_fallback="A crew mate",
                      data={"zone_id": "z-1", "user_id": "campus-u-9", "run_id": "r-1"}, dedupe_key=f"zc:{blocker}")
        assert client.post(URL, json=body, headers=SVC).json()["created"] is True
        n = notes(client, me)[0]
        assert n["title"] == "A crew mate claimed Main Quad." and n["actor"] is None
        assert "Rhea" not in str(n) and "user_id" not in n["data"] and "run_id" not in n["data"]
        assert n["data"]["zone_id"] == "z-1" and n["data"]["route"] == "/zone/z-1"
        assert "Rhea" not in str(pushes.sent[-1])
        client.delete(f"/v1/users/{blocked_id}/block", headers=auth(blocker))


def test_an_unknown_or_missing_actor_reads_as_the_fallback(client, api):
    me = new_sub()
    api.user(me)
    body = campus(me, "never-signed-in", kind="territory.stolen", title="{actor} stole Library Lawn from you.",
                  data={"zone_id": "z-2"}, dedupe_key="ts-1")
    assert client.post(URL, json=body, headers=SVC).json()["created"] is True
    body = campus(me, kind="event.reminder", title="Night run starts in 30 min", data={}, dedupe_key="er-1")
    assert client.post(URL, json=body, headers=SVC).json()["created"] is True
    reminder, stolen = notes(client, me)
    assert stolen["title"] == "Someone stole Library Lawn from you." and stolen["actor"] is None
    assert reminder["title"] == "Night run starts in 30 min" and reminder["data"]["route"] == "/events"


def test_the_placeholder_is_only_ever_replaced_never_formatted(client, api):
    me, host = new_sub(), new_sub()
    api.user(me)
    api.user(host, display_name="Rhea")
    body = campus(me, host, title="{actor} said {0} {user_subject} {actor.__class__}", dedupe_key="fmt-1")
    assert client.post(URL, json=body, headers=SVC).status_code == 200
    assert notes(client, me)[0]["title"] == "Rhea said {0} {user_subject} {actor.__class__}"


def test_the_caller_route_wins_when_it_is_a_path(client, api):
    me = new_sub()
    api.user(me)
    body = campus(me, kind="challenge.invitation", title="New challenge", data={"route": "/challenges"}, dedupe_key="c-1")
    client.post(URL, json=body, headers=SVC)
    body = campus(me, kind="challenge.updated", title="Updated", data={"route": "https://evil.test"}, dedupe_key="c-2")
    client.post(URL, json=body, headers=SVC)
    updated, invited = notes(client, me)
    assert invited["data"]["route"] == "/challenges" and updated["data"]["route"] == "/invites"


def test_text_rules_by_kind(client, api):
    me = new_sub()
    api.user(me)
    assert client.post(URL, json=campus(me, title=None), headers=SVC).status_code == 422  # campus kinds need a title
    run_module = {"user_subject": me, "kind": "territory_lost", "title": "mine", "dedupe_key": "x"}
    assert client.post(URL, json=run_module, headers=SVC).status_code == 422  # Run Module text is Social's
    assert client.post(URL, json=campus(me, kind="meetup.exploded"), headers=SVC).status_code == 422
    assert client.post(URL, json=campus(me), headers={"Authorization": "Bearer nope"}).status_code == 401


# --- Exercise: Partner Hunt Connect ----------------------------------------------------------------

def test_a_partner_request_arrives_naming_nobody(client, api, pushes):
    """Exercise sends no actor for partner.request: the two aren't connected, so nothing in the
    notification may lead to the sender's profile. The anonymous card name is in the title."""
    me = new_sub()
    api.user(me)
    client.post("/v1/me/push-tokens", json={"token": "ExponentPushToken[me]", "platform": "ios"}, headers=auth(me))
    body = {"user_subject": me, "kind": "partner.request", "title": "Ana T. wants to work out with you",
            "body": "Open Partner Hunt to accept or decline.", "data": {"route": "/partner-hunt", "request_id": "r1"},
            "dedupe_key": "partner.request:r1"}
    r = client.post(URL, json=body, headers=SVC)
    assert r.status_code == 200, r.text
    [n] = notes(client, me)
    assert n["kind"] == "partner.request" and n["actor"] is None
    assert n["title"] == "Ana T. wants to work out with you"
    assert n["data"] == {"route": "/partner-hunt", "request_id": "r1"}
    assert pushes.sent[-1]["data"]["kind"] == "partner.request"
    assert client.post(URL, json=body, headers=SVC).json()["created"] is False


def test_a_partner_accept_names_the_accepter_unless_blocked(client, api):
    me, them = new_sub(), new_sub()
    api.user(me)
    them_id = api.user(them, display_name="Ben Kumar")["id"]
    body = {"user_subject": me, "kind": "partner.accepted", "actor_subject": them,
            "title": "{actor} accepted your Partner Hunt request", "body": "You can see each other's profiles now.",
            "data": {"route": "/partner-hunt/connect/r1", "request_id": "r1"}, "dedupe_key": "partner.accepted:r1"}
    assert client.post(URL, json=body, headers=SVC).json()["created"] is True
    [n] = notes(client, me)
    assert n["title"] == "Ben Kumar accepted your Partner Hunt request" and n["actor"]["display_name"] == "Ben Kumar"
    assert n["data"]["route"] == "/partner-hunt/connect/r1"
    client.post(f"/v1/users/{them_id}/block", headers=auth(me))
    assert client.post(URL, json={**body, "dedupe_key": "partner.accepted:r2"}, headers=SVC).json()["created"] is True
    blocked = notes(client, me)[0]
    assert blocked["title"] == "Someone accepted your Partner Hunt request" and blocked["actor"] is None


def test_partner_kinds_route_to_partner_hunt_by_default_and_need_a_title(client, api):
    me = new_sub()
    api.user(me)
    body = {"user_subject": me, "kind": "partner.request", "title": "Someone wants to work out with you",
            "data": {}, "dedupe_key": "pr-default"}
    assert client.post(URL, json=body, headers=SVC).json()["created"] is True
    assert notes(client, me)[0]["data"]["route"] == "/partner-hunt"
    assert client.post(URL, json={**body, "title": None, "dedupe_key": "pr-2"}, headers=SVC).status_code == 422
    assert client.post(URL, json={**body, "kind": "partner.poked", "dedupe_key": "pr-3"}, headers=SVC).status_code == 422
