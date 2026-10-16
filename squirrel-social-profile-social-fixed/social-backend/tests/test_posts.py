from __future__ import annotations

import uuid

from sqlalchemy import event

from tests.conftest import auth, new_sub


# --------------------------------------------------------------------------- create / read / delete


def test_create_and_read_post(api, client):
    sub = new_sub()
    me = api.user(sub, "aanya.moves", city_id="pune", area="Koregaon Park")
    post = api.post(sub, caption="  Just one more km 😅  ", backdrop={"scene": "city-sunset", "seed": 9}, sticker="one-more-km", crew_name="Pune Runners")
    assert post["caption"] == "Just one more km 😅"
    assert post["author"]["id"] == me["id"] and post["author"]["username"] == "aanya.moves"
    assert post["city_id"] == "pune" and post["area"] == "Koregaon Park"  # defaulted from the profile
    assert post["backdrop"] == {"scene": "city-sunset", "seed": 9}
    assert (post["likes_count"], post["comments_count"], post["liked_by_me"], post["is_mine"]) == (0, 0, False, True)
    got = client.get(f"/v1/posts/{post['id']}", headers=auth(new_sub())).json()
    assert got["id"] == post["id"] and got["is_mine"] is False
    assert api.me(sub)["stats"]["posts"] == 1


def test_author_comes_from_token_not_body(api, client):
    sub = new_sub()
    api.me(sub)
    other = api.user(new_sub())["id"]
    r = client.post("/v1/posts", headers=auth(sub), json={"caption": "hi", "author_id": other})
    assert r.status_code == 422  # unknown fields are refused
    r = client.post("/v1/posts", headers=auth(sub), json={"caption": "hi", "likes_count": 900})
    assert r.status_code == 422


def test_post_validation(api, client):
    sub = new_sub()
    api.me(sub)
    bad = [
        {"caption": "x" * 281},
        {"caption": ""},
        {"caption": "ok", "sticker": "not-a-sticker"},
        {"caption": "ok", "backdrop": {"scene": "moon", "seed": 1}},
        {"caption": "ok", "city_id": "gotham"},
        {"caption": "ok", "activity": {"source": "manual", "type": "run", "duration_minutes": 30, "distance_km": 5}},  # runs must be measured
        {"caption": "ok", "activity": {"source": "manual", "type": "meal"}},
        {"caption": "ok", "activity": {"source": "manual", "type": "workout", "duration_minutes": 20}},
        {"caption": "ok", "activity": {"source": "run", "run_id": "../etc/passwd"}},
    ]
    for body in bad:
        assert client.post("/v1/posts", headers=auth(sub), json=body).status_code == 422, body


def test_post_create_rate_limit(api, client, limiter):
    from app.ratelimit import LIMITS

    limiter.limits["post:create"] = LIMITS["post:create"]
    sub = new_sub()
    api.me(sub)
    codes = [client.post("/v1/posts", headers=auth(sub), json={"caption": f"spam {i}"}).status_code for i in range(11)]
    assert codes == [201] * 10 + [429]
    assert api.me(sub)["stats"]["posts"] == 10


def test_delete_own_post(api, client):
    sub = new_sub()
    api.me(sub)
    post = api.post(sub)
    liker = new_sub()
    client.post(f"/v1/posts/{post['id']}/like", headers=auth(liker))
    client.post(f"/v1/posts/{post['id']}/comments", headers=auth(liker), json={"body": "nice"})
    assert client.delete(f"/v1/posts/{post['id']}", headers=auth(sub)).status_code == 204
    assert client.get(f"/v1/posts/{post['id']}", headers=auth(sub)).status_code == 404
    assert api.me(sub)["stats"]["posts"] == 0
    assert client.delete(f"/v1/posts/{post['id']}", headers=auth(sub)).status_code == 404


def test_cannot_delete_someone_elses_post(api, client):
    owner = new_sub()
    api.me(owner)
    post = api.post(owner)
    r = client.delete(f"/v1/posts/{post['id']}", headers=auth(new_sub()))
    assert r.status_code == 403
    assert client.get(f"/v1/posts/{post['id']}", headers=auth(owner)).status_code == 200


def test_moderator_can_delete_post(api, client, database):
    owner, mod = new_sub(), new_sub()
    api.me(owner)
    mod_id = api.user(mod)["id"]
    with database.engine.begin() as c:
        from app.models import User

        c.execute(User.__table__.update().where(User.id == uuid.UUID(mod_id)).values(role="moderator"))
    post = api.post(owner)
    assert client.delete(f"/v1/posts/{post['id']}", headers=auth(mod)).status_code == 204
    assert api.me(owner)["stats"]["posts"] == 0


def test_user_posts_pagination(api, client):
    sub = new_sub()
    uid = api.user(sub)["id"]
    ids = [api.post(sub, caption=f"p{i}")["id"] for i in range(25)]
    got, cursor = [], None
    while True:
        params = {"limit": 10} | ({"cursor": cursor} if cursor else {})
        page = client.get(f"/v1/users/{uid}/posts", params=params, headers=auth(new_sub())).json()
        assert len(page["items"]) <= 10
        got += [p["id"] for p in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert got == list(reversed(ids))


def test_private_authors_posts_are_hidden(api, client):
    owner = new_sub()
    owner_id = api.user(owner, visibility="private")["id"]
    post = api.post(owner, caption="secret")
    stranger = new_sub()
    assert client.get(f"/v1/posts/{post['id']}", headers=auth(stranger)).status_code == 404
    assert client.post(f"/v1/posts/{post['id']}/like", headers=auth(stranger)).status_code == 404
    assert client.get(f"/v1/posts/{post['id']}/comments", headers=auth(stranger)).status_code == 404
    # an accepted follower can see it
    fan = new_sub()
    fan_id = api.user(fan)["id"]
    api.follow(fan, owner_id)
    client.post(f"/v1/users/me/follow-requests/{fan_id}", headers=auth(owner))
    assert client.get(f"/v1/posts/{post['id']}", headers=auth(fan)).status_code == 200


# --------------------------------------------------------------------------- likes


def test_like_unlike_and_counts(api, client):
    author = new_sub()
    api.me(author)
    pid = api.post(author)["id"]
    a, b = new_sub(), new_sub()
    assert client.post(f"/v1/posts/{pid}/like", headers=auth(a)).json() == {"liked": True, "likes_count": 1}
    assert client.post(f"/v1/posts/{pid}/like", headers=auth(b)).json() == {"liked": True, "likes_count": 2}
    # duplicate like: idempotent, not double counted
    assert client.post(f"/v1/posts/{pid}/like", headers=auth(a)).json() == {"liked": True, "likes_count": 2}
    assert client.get(f"/v1/posts/{pid}", headers=auth(a)).json()["liked_by_me"] is True
    assert client.get(f"/v1/posts/{pid}", headers=auth(author)).json()["liked_by_me"] is False
    assert client.delete(f"/v1/posts/{pid}/like", headers=auth(a)).json() == {"liked": False, "likes_count": 1}
    # unliking again doesn't go negative
    assert client.delete(f"/v1/posts/{pid}/like", headers=auth(a)).json() == {"liked": False, "likes_count": 1}


def test_like_missing_post(client):
    r = client.post(f"/v1/posts/{uuid.uuid4()}/like", headers=auth(new_sub()))
    assert r.status_code == 404


def test_crowd_favourite_badge(api, client, limiter):
    author = new_sub()
    api.me(author)
    pid = api.post(author)["id"]
    for _ in range(50):
        client.post(f"/v1/posts/{pid}/like", headers=auth(new_sub()))
    assert "crowd_favourite" in {b["id"] for b in api.me(author)["badges"]}


# --------------------------------------------------------------------------- saves


def test_save_and_list_saved(api, client):
    author, me = new_sub(), new_sub()
    api.me(author)
    p1, p2 = api.post(author, caption="one")["id"], api.post(author, caption="two")["id"]
    assert client.post(f"/v1/posts/{p1}/save", headers=auth(me)).json() == {"saved": True}
    client.post(f"/v1/posts/{p2}/save", headers=auth(me))
    client.post(f"/v1/posts/{p2}/save", headers=auth(me))  # idempotent
    saved = client.get("/v1/users/me/saved", headers=auth(me)).json()["items"]
    assert [p["id"] for p in saved] == [p2, p1] and all(p["saved_by_me"] for p in saved)
    client.delete(f"/v1/posts/{p1}/save", headers=auth(me))
    assert [p["id"] for p in client.get("/v1/users/me/saved", headers=auth(me)).json()["items"]] == [p2]


# --------------------------------------------------------------------------- comments


def test_comments_create_read_delete(api, client):
    author, c1, c2 = new_sub(), new_sub(), new_sub()
    api.me(author)
    api.user(c1, "commenter.one")
    api.me(c2)
    pid = api.post(author)["id"]
    r = client.post(f"/v1/posts/{pid}/comments", headers=auth(c1), json={"body": "  That sunset 😍  "})
    assert r.status_code == 201
    first = r.json()
    assert first["body"] == "That sunset 😍" and first["author"]["username"] == "commenter.one" and first["can_delete"] is True
    client.post(f"/v1/posts/{pid}/comments", headers=auth(c2), json={"body": "Pace looking strong"})

    page = client.get(f"/v1/posts/{pid}/comments", headers=auth(c2)).json()
    assert page["total"] == 2
    assert [c["body"] for c in page["items"]] == ["That sunset 😍", "Pace looking strong"]  # oldest first
    assert [c["can_delete"] for c in page["items"]] == [False, True]
    assert client.get(f"/v1/posts/{pid}", headers=auth(c2)).json()["comments_count"] == 2

    assert client.delete(f"/v1/comments/{first['id']}", headers=auth(c1)).status_code == 204
    assert client.get(f"/v1/posts/{pid}", headers=auth(c2)).json()["comments_count"] == 1
    assert client.delete(f"/v1/comments/{first['id']}", headers=auth(c1)).status_code == 404


def test_cannot_delete_someone_elses_comment(api, client):
    author, commenter = new_sub(), new_sub()
    api.me(author)
    pid = api.post(author)["id"]
    cid = client.post(f"/v1/posts/{pid}/comments", headers=auth(commenter), json={"body": "mine"}).json()["id"]
    assert client.delete(f"/v1/comments/{cid}", headers=auth(new_sub())).status_code == 403
    # the post author isn't a moderator either
    assert client.delete(f"/v1/comments/{cid}", headers=auth(author)).status_code == 403
    assert client.get(f"/v1/posts/{pid}/comments", headers=auth(author)).json()["total"] == 1


def test_comment_validation(api, client):
    author = new_sub()
    api.me(author)
    pid = api.post(author)["id"]
    for body in ({"body": ""}, {"body": "   "}, {"body": "x" * 501}, {}):
        assert client.post(f"/v1/posts/{pid}/comments", headers=auth(author), json=body).status_code == 422


def test_comments_pagination(api, client):
    author = new_sub()
    api.me(author)
    pid = api.post(author)["id"]
    for i in range(23):
        client.post(f"/v1/posts/{pid}/comments", headers=auth(author), json={"body": f"c{i}"})
    got, cursor = [], None
    while True:
        params = {"limit": 10} | ({"cursor": cursor} if cursor else {})
        page = client.get(f"/v1/posts/{pid}/comments", params=params, headers=auth(author)).json()
        got += [c["body"] for c in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert got == [f"c{i}" for i in range(23)]


def test_comment_rate_limit(api, client, limiter):
    limiter.limits["comment:create"] = (2, 60)
    author = new_sub()
    api.me(author)
    pid = api.post(author)["id"]
    codes = [client.post(f"/v1/posts/{pid}/comments", headers=auth(author), json={"body": "x"}).status_code for _ in range(3)]
    assert codes == [201, 201, 429]


# --------------------------------------------------------------------------- query budget (no N+1)


def test_feed_page_query_count_is_constant(api, client, database):
    subs = [new_sub() for _ in range(15)]
    for s in subs:
        api.me(s)
        api.post(s, activity={"source": "manual", "type": "yoga", "duration_minutes": 30})
    viewer = new_sub()
    api.me(viewer)
    for p in api.feed(viewer, limit=15)["items"][:5]:
        client.post(f"/v1/posts/{p['id']}/like", headers=auth(viewer))

    statements: list[str] = []

    def count(*args):
        statements.append(args[2])

    event.listen(database.engine, "before_cursor_execute", count)
    try:
        small = api.feed(viewer, limit=3)
        n_small = len(statements)
        statements.clear()
        big = api.feed(viewer, limit=15)
        n_big = len(statements)
    finally:
        event.remove(database.engine, "before_cursor_execute", count)
    assert len(small["items"]) == 3 and len(big["items"]) == 15
    assert n_small == n_big, (n_small, n_big)
    assert n_big <= 7
