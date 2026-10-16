from __future__ import annotations

import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from tests.conftest import auth, make_token, new_sub

LOOK = {
    "body": "female", "skin": "#C98A5E", "hair": "bun", "hairColor": "#1A1116", "top": "crop", "topColor": "#16101E",
    "bottom": "joggers", "bottomColor": "#1B1524", "shoeColor": "#FFFFFF", "accessory": "none",
}


# --------------------------------------------------------------------------- authentication


def test_requires_bearer_token(client):
    r = client.get("/v1/users/me/profile")
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"
    assert r.json()["code"] == "unauthorized"


def test_rejects_expired_token(client):
    r = client.get("/v1/users/me/profile", headers={"Authorization": f"Bearer {make_token(new_sub(), exp_in=-120)}"})
    assert r.status_code == 401
    assert "expired" in r.json()["detail"]


def test_rejects_token_signed_by_another_key(client):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = other.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    r = client.get("/v1/users/me/profile", headers={"Authorization": f"Bearer {make_token(new_sub(), key=pem)}"})
    assert r.status_code == 401


def test_rejects_algorithm_confusion(client):
    """Classic RS256→HS256 attack: HMAC-sign with the (public) RSA key as the secret."""
    import base64
    import hashlib
    import hmac

    from tests.conftest import PUBLIC_PEM

    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    signing_input = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()) + "." + b64(json.dumps({"sub": "attacker", "exp": 9999999999}).encode())
    sig = b64(hmac.new(PUBLIC_PEM.encode(), signing_input.encode(), hashlib.sha256).digest())
    r = client.get("/v1/users/me/profile", headers={"Authorization": f"Bearer {signing_input}.{sig}"})
    assert r.status_code == 401


# --------------------------------------------------------------------------- profile


def test_first_request_creates_profile(api):
    sub = new_sub()
    me = api.me(sub)
    assert me["is_me"] is True
    assert me["username_confirmed"] is False
    assert me["user"]["username"].startswith("user_")
    assert me["stats"] == {
        "xp": 0, "level": 1, "level_xp": 0, "xp_per_level": 2000, "xp_synced_at": None,
        "streak_days": 0, "followers": 0, "following": 0, "posts": 0, "activities": 0,
        "month": me["stats"]["month"], "month_km": 0.0, "month_runs": 0, "month_workouts": 0,
    }
    # same account → same profile
    assert api.me(sub)["user"]["id"] == me["user"]["id"]


def test_profile_never_exposes_private_fields(api, client):
    sub = new_sub()
    uid = api.user(sub, "aanya.moves")["id"]
    body = json.dumps(client.get(f"/v1/users/{uid}/profile", headers=auth(new_sub())).json())
    assert sub not in body  # the auth subject is internal
    for key in ("auth_subject", "email", "password", "role", "storage_key"):
        assert key not in body


def test_update_profile(api, client):
    sub = new_sub()
    api.me(sub)
    r = client.patch(
        "/v1/users/me/profile",
        headers=auth(sub),
        json={
            "username": "Aanya.Moves", "display_name": "  Aanya S.  ", "bio": "Building a healthier me 🌱", "city_id": "pune",
            "area": "Koregaon Park", "college": "COEP", "interests": ["Runner", "Yoga", "runner", " "], "avatar_look": LOOK,
        },
    )
    assert r.status_code == 200, r.text
    u = r.json()["user"]
    assert u["username"] == "aanya.moves"  # normalised to lowercase
    assert u["display_name"] == "Aanya S."
    assert u["interests"] == ["Runner", "Yoga"]  # de-duplicated, blanks dropped
    assert u["avatar_look"] == LOOK
    assert r.json()["username_confirmed"] is True
    # clearing optional fields with null
    r = client.patch("/v1/users/me/profile", headers=auth(sub), json={"college": None, "city_id": None})
    assert r.json()["user"]["college"] is None and r.json()["user"]["city_id"] is None


def test_client_cannot_write_derived_fields(api, client):
    sub = new_sub()
    api.me(sub)
    for body in ({"xp": 99999}, {"followers": 5000}, {"level": 40}, {"verified": True}, {"role": "admin"}):
        r = client.patch("/v1/users/me/profile", headers=auth(sub), json=body)
        assert r.status_code == 422, body
    assert api.me(sub)["stats"]["xp"] == 0


def test_invalid_usernames(api, client):
    sub = new_sub()
    api.me(sub)
    for bad in ("ab", "1runner", "has space", "dots..twice", "ends.", "way_too_long_username_x", "admin", "émoji"):
        r = client.patch("/v1/users/me/profile", headers=auth(sub), json={"username": bad})
        assert r.status_code == 422, bad
        assert r.json()["code"] == "invalid_username"


def test_duplicate_username(api, client):
    api.user(new_sub(), "rhea.runs")
    sub = new_sub()
    api.me(sub)
    r = client.patch("/v1/users/me/profile", headers=auth(sub), json={"username": "RHEA.runs"})
    assert r.status_code == 409
    assert r.json()["code"] == "username_taken"


def test_username_availability(api, client):
    owner = new_sub()
    api.user(owner, "zoya.hiit")
    viewer = new_sub()

    def check(name, sub=viewer):
        return client.get(f"/v1/users/username/{name}/availability", headers=auth(sub)).json()

    assert check("zoya.hiit") == {"username": "zoya.hiit", "available": False, "reason": "That username is taken."}
    assert check("Zoya.Hiit")["available"] is False
    assert check("zoya.hiit", owner)["available"] is True  # your own name is "available" to you
    assert check("fresh_name")["available"] is True
    bad = check("x")
    assert bad["available"] is False and "characters" in bad["reason"]


def test_profile_validation(api, client):
    sub = new_sub()
    api.me(sub)
    cases = [
        {"city_id": "atlantis"},
        {"bio": "x" * 161},
        {"display_name": ""},
        {"interests": [f"i{n}" for n in range(9)]},
        {"avatar_look": {**LOOK, "hair": "mohawk"}},
        {"avatar_look": {**LOOK, "skin": "red"}},
        {"visibility": "friends"},
    ]
    for body in cases:
        assert client.patch("/v1/users/me/profile", headers=auth(sub), json=body).status_code == 422, body


def test_public_profile_and_recent_posts(api, client):
    author = new_sub()
    uid = api.user(author, "meera.flows", city_id="pune", bio="Yoga host")["id"]
    for i in range(12):
        api.post(author, caption=f"flow {i}")
    viewer = new_sub()
    api.follow(viewer, uid)
    p = client.get(f"/v1/users/{uid}/profile", headers=auth(viewer)).json()
    assert p["is_me"] is False and p["restricted"] is False
    assert p["user"]["bio"] == "Yoga host"
    assert p["stats"]["posts"] == 12 and p["stats"]["followers"] == 1
    assert [x["caption"] for x in p["recent_posts"]] == [f"flow {i}" for i in range(11, 2, -1)]  # 9 newest
    assert p["relationship"] == {"following": True, "followed_by": False, "requested": False}
    assert {b["id"] for b in p["badges"]} == {"first_post"}


def test_unknown_profile_404(client):
    r = client.get("/v1/users/00000000-0000-0000-0000-000000000000/profile", headers=auth(new_sub()))
    assert r.status_code == 404


def test_xp_is_read_from_run_module(api, run_module):
    sub = new_sub()
    run_module.xp[sub] = 12 * 2000 + 750
    me = api.me(sub)
    assert me["stats"]["xp"] == 24750
    assert me["stats"]["level"] == 13 and me["stats"]["level_xp"] == 750
    assert me["stats"]["xp_synced_at"] is not None
    # Run Module unavailable: the cached value is served, not zeroed.
    run_module.xp.pop(sub)
    assert api.me(sub)["stats"]["xp"] == 24750


def test_author_level_in_feed_comes_from_synced_xp(api, run_module):
    sub = new_sub()
    run_module.xp[sub] = 5 * 2000
    api.me(sub)
    api.post(sub)
    assert api.feed(new_sub())["items"][0]["author"]["level"] == 6


def test_private_profile_is_restricted_to_followers(api, client):
    owner = new_sub()
    uid = api.user(owner, "isha.private", visibility="private", bio="secret bio", city_id="pune")["id"]
    api.post(owner, caption="private post")
    stranger = new_sub()
    p = client.get(f"/v1/users/{uid}/profile", headers=auth(stranger)).json()
    assert p["restricted"] is True
    assert p["user"]["bio"] is None and p["user"]["city_id"] is None
    assert p["recent_posts"] == [] and p["badges"] == []
    assert p["user"]["username"] == "isha.private"  # identity stays visible
    assert client.get(f"/v1/users/{uid}/posts", headers=auth(stranger)).status_code == 403
    assert client.get(f"/v1/users/{uid}/followers", headers=auth(stranger)).status_code == 403


def test_search_and_suggestions(api, client):
    me = new_sub()
    api.user(me, "viewer", city_id="pune")
    a = api.user(new_sub(), "aarav.lifts", display_name="Aarav M.", city_id="pune")["id"]
    b = api.user(new_sub(), "neil.bandra", display_name="Neil D.", city_id="mumbai")["id"]
    api.user(new_sub(), "percent_guy", display_name="100% Real")

    hits = client.get("/v1/users/search", params={"q": "aar"}, headers=auth(me)).json()["items"]
    assert [h["id"] for h in hits] == [a]
    assert client.get("/v1/users/search", params={"q": "%"}, headers=auth(me)).status_code == 422  # too short
    assert [h["username"] for h in client.get("/v1/users/search", params={"q": "0%"}, headers=auth(me)).json()["items"]] == ["percent_guy"]

    sugg = [s["id"] for s in client.get("/v1/users/suggestions", headers=auth(me)).json()["items"]]
    assert sugg[0] == a  # same city first
    api.follow(me, a)
    sugg = [s["id"] for s in client.get("/v1/users/suggestions", headers=auth(me)).json()["items"]]
    assert a not in sugg and b in sugg
