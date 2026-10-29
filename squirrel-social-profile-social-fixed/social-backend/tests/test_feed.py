from __future__ import annotations

from tests.conftest import auth, new_sub


def _ids(page):
    return [p["id"] for p in page["items"]]


def test_for_you_is_newest_first_and_includes_everyone_public(api):
    a, b, viewer = new_sub(), new_sub(), new_sub()
    api.me(a)
    api.me(b)
    api.me(viewer)
    p1 = api.post(a, caption="1")["id"]
    p2 = api.post(b, caption="2")["id"]
    p3 = api.post(viewer, caption="3")["id"]
    assert _ids(api.feed(viewer, "for_you")) == [p3, p2, p1]


def test_following_feed(api):
    viewer, followed, stranger = new_sub(), new_sub(), new_sub()
    api.me(viewer)
    followed_id = api.user(followed)["id"]
    api.me(stranger)
    mine = api.post(viewer, caption="me")["id"]
    theirs = api.post(followed, caption="friend")["id"]
    api.post(stranger, caption="stranger")
    assert _ids(api.feed(viewer, "following")) == [mine]  # own posts show before following anyone
    api.follow(viewer, followed_id)
    assert _ids(api.feed(viewer, "following")) == [theirs, mine]


def test_following_feed_excludes_pending_requests(api):
    viewer, private = new_sub(), new_sub()
    api.me(viewer)
    pid = api.user(private, visibility="private")["id"]
    api.post(private, caption="hidden")
    assert api.follow(viewer, pid)["requested"] is True
    assert api.feed(viewer, "following")["items"] == []
    assert api.feed(viewer, "for_you")["items"] == []


def test_nearby_uses_city_param_or_profile_city(api):
    pune, mumbai, viewer = new_sub(), new_sub(), new_sub()
    api.user(pune, city_id="pune")
    api.user(mumbai, city_id="mumbai")
    api.user(viewer, city_id="mumbai")
    p_pune = api.post(pune, caption="KP loop")["id"]
    p_mumbai = api.post(mumbai, caption="Marine Drive")["id"]
    p_explicit = api.post(pune, caption="visiting", city_id="mumbai")["id"]
    assert _ids(api.feed(viewer, "nearby")) == [p_explicit, p_mumbai]
    assert _ids(api.feed(viewer, "nearby", city="pune")) == [p_pune]


def test_nearby_without_a_city_is_empty(api, client):
    viewer = new_sub()
    api.me(viewer)
    api.post(viewer)
    assert api.feed(viewer, "nearby") == {"items": [], "next_cursor": None}
    assert client.get("/v1/feed", params={"feed": "nearby", "city": "narnia"}, headers=auth(viewer)).status_code == 422


def test_unknown_feed_kind(client):
    assert client.get("/v1/feed", params={"feed": "trending"}, headers=auth(new_sub())).status_code == 422


def test_feed_requires_auth(client):
    assert client.get("/v1/feed").status_code == 401


def test_feed_pagination_is_stable_while_new_posts_arrive(api):
    author, viewer = new_sub(), new_sub()
    api.me(author)
    api.me(viewer)
    ids = [api.post(author, caption=str(i))["id"] for i in range(30)]
    page1 = api.feed(viewer, limit=12)
    assert len(page1["items"]) == 12 and page1["next_cursor"]
    api.post(author, caption="new, arrives mid-scroll")
    page2 = api.feed(viewer, limit=12, cursor=page1["next_cursor"])
    page3 = api.feed(viewer, limit=12, cursor=page2["next_cursor"])
    assert page3["next_cursor"] is None
    assert _ids(page1) + _ids(page2) + _ids(page3) == list(reversed(ids))


def test_feed_limit_is_capped(api):
    author = new_sub()
    api.me(author)
    for i in range(55):
        api.post(author, caption=str(i))
    assert len(api.feed(author, limit=1000)["items"]) == 50


def test_feed_carries_viewer_state(api, client):
    author, viewer = new_sub(), new_sub()
    api.user(author, "rhea.runs")
    api.me(viewer)
    pid = api.post(author, caption="liked one")["id"]
    other = api.post(author, caption="not liked")["id"]
    client.post(f"/v1/posts/{pid}/like", headers=auth(viewer))
    client.post(f"/v1/posts/{other}/save", headers=auth(viewer))
    items = {p["id"]: p for p in api.feed(viewer)["items"]}
    assert (items[pid]["liked_by_me"], items[pid]["likes_count"], items[pid]["saved_by_me"]) == (True, 1, False)
    assert (items[other]["liked_by_me"], items[other]["saved_by_me"]) == (False, True)
    author_obj = items[pid]["author"]
    assert set(author_obj) == {"id", "username", "display_name", "avatar_look", "avatar_url", "level", "verified"}
    assert items[pid]["following_author"] is False
    api.follow(viewer, author_obj["id"])
    assert all(p["following_author"] for p in api.feed(viewer)["items"])
    # the author sees a clean slate for their own likes
    assert api.feed(author)["items"][1]["liked_by_me"] is False
