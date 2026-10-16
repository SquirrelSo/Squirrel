from __future__ import annotations

from tests.conftest import auth, new_sub


def _counts(api, sub):
    s = api.me(sub)["stats"]
    return s["followers"], s["following"]


def test_follow_and_counts(api, client):
    a, b = new_sub(), new_sub()
    api.me(a)
    b_id = api.user(b, "rhea.runs")["id"]
    r = api.follow(a, b_id)
    assert r == {"following": True, "followed_by": False, "requested": False, "followers": 1, "following_count": 0}
    assert _counts(api, a) == (0, 1)
    assert _counts(api, b) == (1, 0)


def test_duplicate_follow_is_idempotent(api):
    a, b = new_sub(), new_sub()
    api.me(a)
    b_id = api.user(b)["id"]
    api.follow(a, b_id)
    again = api.follow(a, b_id)
    assert again["following"] is True and again["followers"] == 1
    assert _counts(api, b) == (1, 0)


def test_unfollow_and_unfollow_twice(api, client):
    a, b = new_sub(), new_sub()
    api.me(a)
    b_id = api.user(b)["id"]
    api.follow(a, b_id)
    for _ in range(2):  # second unfollow is a harmless no-op
        r = client.delete(f"/v1/users/{b_id}/follow", headers=auth(a))
        assert r.status_code == 200
        assert r.json()["following"] is False and r.json()["followers"] == 0
    assert _counts(api, a) == (0, 0)


def test_unfollow_never_followed(api, client):
    a = new_sub()
    api.me(a)
    b_id = api.user(new_sub())["id"]
    r = client.delete(f"/v1/users/{b_id}/follow", headers=auth(a))
    assert r.status_code == 200 and r.json()["followers"] == 0


def test_cannot_follow_self(api, client):
    a = new_sub()
    my_id = api.user(a)["id"]
    r = client.post(f"/v1/users/{my_id}/follow", headers=auth(a))
    assert r.status_code == 422 and r.json()["code"] == "self_follow"
    assert _counts(api, a) == (0, 0)


def test_follow_unknown_user(client):
    r = client.post("/v1/users/00000000-0000-0000-0000-000000000001/follow", headers=auth(new_sub()))
    assert r.status_code == 404


def test_follow_requires_auth(api, client):
    b_id = api.user(new_sub())["id"]
    assert client.post(f"/v1/users/{b_id}/follow").status_code == 401


def test_follow_status_both_ways(api, client):
    a, b = new_sub(), new_sub()
    a_id = api.user(a)["id"]
    b_id = api.user(b)["id"]
    api.follow(b, a_id)
    s = client.get(f"/v1/users/{b_id}/follow-status", headers=auth(a)).json()
    assert s == {"following": False, "followed_by": True, "requested": False}
    api.follow(a, b_id)
    s = client.get(f"/v1/users/{b_id}/follow-status", headers=auth(a)).json()
    assert s == {"following": True, "followed_by": True, "requested": False}


def test_followers_and_following_lists_paginate(api, client):
    star = new_sub()
    star_id = api.user(star, "meera.flows")["id"]
    fans = []
    for i in range(7):
        s = new_sub()
        fans.append(api.user(s, f"fan_{i}")["id"])
        api.follow(s, star_id)
    viewer = new_sub()
    api.me(viewer)
    api.follow(viewer, fans[0])

    seen, cursor = [], None
    while True:
        params = {"limit": 3} | ({"cursor": cursor} if cursor else {})
        page = client.get(f"/v1/users/{star_id}/followers", params=params, headers=auth(viewer)).json()
        seen += page["items"]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert [u["id"] for u in seen] == list(reversed(fans))  # newest follower first, no dupes, none missing
    # each row carries the viewer's relationship, so the list can render Follow buttons
    assert {u["id"]: u["following"] for u in seen}[fans[0]] is True
    assert all(set(u) >= {"username", "display_name", "avatar_look", "level"} for u in seen)

    following = client.get(f"/v1/users/{fans[3]}/following", headers=auth(viewer)).json()["items"]
    assert [u["id"] for u in following] == [star_id]


def test_invalid_cursor(api, client):
    uid = api.user(new_sub())["id"]
    r = client.get(f"/v1/users/{uid}/followers", params={"cursor": "garbage!!"}, headers=auth(new_sub()))
    assert r.status_code == 422 and r.json()["code"] == "invalid_cursor"


def test_private_account_follow_requests(api, client):
    owner, fan = new_sub(), new_sub()
    owner_id = api.user(owner, "private.person", visibility="private")["id"]
    fan_id = api.user(fan)["id"]

    r = api.follow(fan, owner_id)
    assert r["following"] is False and r["requested"] is True and r["followers"] == 0
    reqs = client.get("/v1/users/me/follow-requests", headers=auth(owner)).json()["items"]
    assert [u["id"] for u in reqs] == [fan_id]

    ok = client.post(f"/v1/users/me/follow-requests/{fan_id}", headers=auth(owner))
    assert ok.status_code == 200 and ok.json()["followed_by"] is True
    assert _counts(api, owner) == (1, 0)
    assert _counts(api, fan) == (0, 1)
    # accepting twice is harmless
    assert client.post(f"/v1/users/me/follow-requests/{fan_id}", headers=auth(owner)).status_code == 200
    assert _counts(api, owner) == (1, 0)
    assert client.get(f"/v1/users/{owner_id}/profile", headers=auth(fan)).json()["restricted"] is False


def test_decline_request_and_going_public_accepts_pending(api, client):
    owner = new_sub()
    owner_id = api.user(owner, visibility="private")["id"]
    f1, f2 = new_sub(), new_sub()
    f1_id = api.user(f1)["id"]
    api.me(f2)
    api.follow(f1, owner_id)
    api.follow(f2, owner_id)
    assert client.delete(f"/v1/users/me/follow-requests/{f1_id}", headers=auth(owner)).json()["followed_by"] is False
    assert client.post(f"/v1/users/me/follow-requests/{f1_id}", headers=auth(owner)).status_code == 404

    client.patch("/v1/users/me/profile", headers=auth(owner), json={"visibility": "public"})
    assert _counts(api, owner) == (1, 0)
    assert _counts(api, f2) == (0, 1)
    assert client.get("/v1/users/me/follow-requests", headers=auth(owner)).json()["items"] == []


def test_counts_stay_consistent_under_churn(api, client):
    hub = new_sub()
    hub_id = api.user(hub)["id"]
    subs = [new_sub() for _ in range(5)]
    for s in subs:
        api.me(s)
    for _ in range(3):
        for s in subs:
            api.follow(s, hub_id)
            api.follow(s, hub_id)
        for s in subs[:2]:
            client.delete(f"/v1/users/{hub_id}/follow", headers=auth(s))
            client.delete(f"/v1/users/{hub_id}/follow", headers=auth(s))
    assert _counts(api, hub) == (3, 0)
    listed = client.get(f"/v1/users/{hub_id}/followers", params={"limit": 50}, headers=auth(hub)).json()["items"]
    assert len(listed) == 3


def test_rate_limited_follows(api, client, limiter):
    limiter.limits["follow"] = (3, 60)
    a = new_sub()
    api.me(a)
    targets = [api.user(new_sub())["id"] for _ in range(4)]
    codes = [client.post(f"/v1/users/{t}/follow", headers=auth(a)).status_code for t in targets]
    assert codes == [200, 200, 200, 429]
    r = client.post(f"/v1/users/{targets[0]}/follow", headers=auth(a))
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1
