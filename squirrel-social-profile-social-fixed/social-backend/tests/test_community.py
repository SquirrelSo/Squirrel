"""Waitlist and referrals, founding badges, hostels, XP boards, daily stats and "km this month"."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import update

from app.models import Member
from tests.conftest import auth, make_token, new_sub


def verified(sub: str) -> dict[str, str]:
    """A token of an account that verified its email at sign-up (the Exercise backend's `ev`)."""
    return {"Authorization": f"Bearer {make_token(sub, ev=True)}"}


def membership(client, headers) -> dict:
    r = client.get("/v1/me/membership", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def badge_ids(client, headers) -> list[str]:
    return [b["id"] for b in client.get("/v1/users/me/profile", headers=headers).json()["badges"]]


# --------------------------------------------------------------------------- waitlist


def test_everyone_joins_the_line_in_order_and_is_admitted(client):
    subs = [new_sub() for _ in range(3)]
    rows = [membership(client, auth(s)) for s in subs]
    assert [r["position"] for r in rows] == [1, 2, 3]
    assert all(r["admitted"] for r in rows)
    assert rows[2]["members_total"] == 3
    assert len({r["referral_code"] for r in rows}) == 3
    assert rows[0]["invite_url"] == f"https://app.test/sign-in?mode=create&invite={rows[0]['referral_code']}"


def test_three_verified_friends_skip_the_line(client, pushes):
    early = [new_sub() for _ in range(4)]
    for s in early:
        membership(client, verified(s))
    me = new_sub()
    mine = membership(client, verified(me))
    assert mine["effective_position"] == 5 and mine["referrals_to_skip"] == 3

    for i in range(3):
        friend = new_sub()
        r = client.post("/v1/me/referral", json={"code": mine["referral_code"].lower()}, headers=verified(friend))
        assert r.status_code == 200, r.text
        assert r.json()["referred_by"]["id"]
        now = membership(client, verified(me))
        assert now["referrals"] == i + 1
    assert now["skipped"] is True
    assert now["effective_position"] == 1  # ahead of the four who joined first
    assert membership(client, verified(early[0]))["effective_position"] == 2

    titles = [n["title"] for n in client.get("/v1/notifications", headers=verified(me)).json()["items"]]
    assert sum("joined with your invite" in t for t in titles) == 3


def test_unverified_friends_do_not_count(client):
    me = new_sub()
    code = membership(client, verified(me))["referral_code"]
    assert client.post("/v1/me/referral", json={"code": code}, headers=auth(new_sub())).status_code == 200
    assert membership(client, verified(me))["referrals"] == 0


def test_a_code_is_claimed_once_never_your_own_and_must_exist(client):
    me, a, b = new_sub(), new_sub(), new_sub()
    code_a = membership(client, verified(a))["referral_code"]
    code_b = membership(client, verified(b))["referral_code"]
    own = membership(client, verified(me))["referral_code"]
    assert client.post("/v1/me/referral", json={"code": own}, headers=verified(me)).status_code == 422
    assert client.post("/v1/me/referral", json={"code": "NOPE2345"}, headers=verified(me)).status_code == 404
    assert client.post("/v1/me/referral", json={"code": code_a}, headers=verified(me)).status_code == 200
    assert client.post("/v1/me/referral", json={"code": code_b}, headers=verified(me)).status_code == 409
    assert membership(client, verified(a))["referrals"] == 1
    assert membership(client, verified(b))["referrals"] == 0


def test_codes_work_only_in_the_first_two_weeks(client, database):
    me, friend = new_sub(), new_sub()
    code = membership(client, verified(friend))["referral_code"]
    my_id = client.get("/v1/users/me/profile", headers=verified(me)).json()["user"]["id"]
    with database.engine.begin() as conn:
        conn.execute(update(Member).where(Member.user_id == uuid.UUID(my_id))
                     .values(joined_at=datetime.now(timezone.utc) - timedelta(days=15)))
    assert client.post("/v1/me/referral", json={"code": code}, headers=verified(me)).status_code == 422


# --------------------------------------------------------------------------- founding badges


def test_the_first_verified_members_are_founding(client, settings, pushes):
    unverified = new_sub()
    membership(client, auth(unverified))  # joined first, but never verified: not founding
    subs = [new_sub() for _ in range(settings.founding_first + 2)]
    for s in subs:
        membership(client, verified(s))
    assert badge_ids(client, auth(unverified)) == []
    first = membership(client, verified(subs[0]))
    assert first["founding"] == {"badge_id": "founding_squirrel", "title": "Founding Squirrel", "rank": 1}
    assert badge_ids(client, verified(subs[settings.founding_first - 1])) == ["founding_squirrel"]
    assert badge_ids(client, verified(subs[settings.founding_first])) == ["founding_500"]
    assert membership(client, verified(subs[-1]))["founding"]["rank"] == settings.founding_first + 2
    # the badge came with a notification
    kinds = [n["kind"] for n in client.get("/v1/notifications", headers=verified(subs[0])).json()["items"]]
    assert kinds == ["badge"]


def test_past_the_first_500_no_founding_badge(client, database, settings):
    filler = new_sub()
    membership(client, verified(filler))
    with database.engine.begin() as conn:  # pretend 500 verified members came before
        conn.execute(update(Member).values(verified_rank=settings.founding_total))
    late = new_sub()
    assert membership(client, verified(late))["founding"] is None
    assert badge_ids(client, verified(late)) == []


# --------------------------------------------------------------------------- hostels


def test_hostels_are_hidden_until_configured(client):
    sub = new_sub()
    assert client.get("/v1/community/config", headers=auth(sub)).json()["hostels"] == []
    r = client.patch("/v1/users/me/profile", json={"hostel": "Anywhere"}, headers=auth(sub))
    assert r.status_code == 422
    board = client.get("/v1/leaderboards/hostels", headers=auth(sub)).json()
    assert board["enabled"] is False and board["entries"] == []


def test_hostel_vs_hostel_sums_members_xp(settings, database, run_module, storage, limiter, pushes):
    from dataclasses import replace

    from fastapi.testclient import TestClient

    from app.main import create_app

    client = TestClient(create_app(replace(settings, hostels=("Hostel A", "Hostel B", "Hostel C")), database=database,
                                   run_module=run_module, storage=storage, limiter=limiter, push=pushes))
    a1, a2, b1, nobody = new_sub(), new_sub(), new_sub(), new_sub()
    for sub, hostel in ((a1, "Hostel A"), (a2, "Hostel A"), (b1, "Hostel B")):
        assert client.patch("/v1/users/me/profile", json={"hostel": hostel}, headers=auth(sub)).status_code == 200
    assert client.patch("/v1/users/me/profile", json={"hostel": "Hostel Z"}, headers=auth(nobody)).status_code == 422
    run_module.board_xp = {a1: 40, a2: 30, b1: 120, nobody: 500}
    board = client.get("/v1/leaderboards/hostels", params={"window": "weekly"}, headers=auth(a1)).json()
    assert board["enabled"] and board["available"]
    assert [(e["hostel"], e["xp"], e["members"], e["active"]) for e in board["entries"]] == [
        ("Hostel B", 120, 1, 1), ("Hostel A", 70, 2, 2), ("Hostel C", 0, 0, 0)]
    assert [e["is_mine"] for e in board["entries"]] == [False, True, False]
    assert ("xp_board", "weekly") in run_module.calls
    assert client.get("/v1/community/config", headers=auth(a1)).json()["hostels"] == ["Hostel A", "Hostel B", "Hostel C"]


# --------------------------------------------------------------------------- XP board


def test_daily_top_10_names_the_people(client, run_module, api):
    subs = [new_sub() for _ in range(12)]
    for i, s in enumerate(subs):
        api.user(s, username=f"runner{i:02d}")
    run_module.board_xp = {s: 10 * (i + 1) for i, s in enumerate(subs)}
    run_module.board_xp[new_sub()] = 999  # an account that never opened Social: skipped
    board = client.get("/v1/leaderboards/xp", headers=auth(subs[0])).json()
    assert board["available"] and board["window"] == "daily"
    assert len(board["entries"]) <= 10
    top = board["entries"][0]
    assert (top["rank"], top["user"]["username"], top["xp"]) == (2, "runner11", 120)
    assert board["me"]["rank"] == 13 and board["me"]["is_me"] and board["me"]["xp"] == 10


def test_the_board_says_when_xp_is_unavailable(client, run_module):
    run_module.board_available = False
    board = client.get("/v1/leaderboards/xp", headers=auth(new_sub())).json()
    assert board == {**board, "available": False, "entries": [], "me": None}


# --------------------------------------------------------------------------- daily stats & month


def _activity(client, sub, source_ref, *, type_="run", distance_m=5000, started_at=None):
    body = {"user_subject": sub, "source": "run_module" if type_ == "run" else "exercise", "source_ref": source_ref,
            "type": type_, "name": "Morning run" if type_ == "run" else "Squats", "distance_m": distance_m if type_ == "run" else None,
            "duration_s": 1800, "started_at": started_at or datetime.now(timezone.utc).isoformat()}
    r = client.post("/internal/v1/activities", json=body, headers={"Authorization": "Bearer svc-secret"})
    assert r.status_code in (200, 201), r.text


def test_daily_stats_count_the_campus_and_me(client):
    me, other = new_sub(), new_sub()
    _activity(client, me, "r1", distance_m=4200)
    _activity(client, other, "r2", distance_m=6000)
    _activity(client, other, "w1", type_="workout")
    _activity(client, other, "old", started_at=(datetime.now(timezone.utc) - timedelta(days=3)).isoformat())
    stats = client.get("/v1/stats/daily", params={"days": 7}, headers=auth(me)).json()
    assert stats["today"] == {**stats["today"], "active_members": 2, "runs": 2, "km": 10.2, "workouts": 1}
    assert stats["me_today"] == {"runs": 1, "km": 4.2, "workouts": 0}
    assert len(stats["days"]) == 7
    assert sum(d["runs"] for d in stats["days"]) == 3


def test_profile_shows_verified_km_this_month(client):
    me = new_sub()
    _activity(client, me, "m1", distance_m=21_000)
    _activity(client, me, "m2", distance_m=26_000)
    _activity(client, me, "m3", type_="workout")
    stats = client.get("/v1/users/me/profile", headers=auth(me)).json()["stats"]
    assert stats["month_km"] == 47.0 and stats["month_runs"] == 2 and stats["month_workouts"] == 1
