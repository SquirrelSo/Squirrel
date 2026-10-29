"""The ambassador programme: profile on approval, suspend/reinstate, tasks and their XP, referrals
(listing, integrity, late verification, activation, rewards through the Run Module), reversal,
analytics, leaderboard, and the admin guard."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select, update

from app.db import utcnow
from app.models import AmbassadorApplication, AmbassadorReward, Member, User
from app.services import ambassador as ambassador_service
from tests.conftest import auth, make_token, new_sub

SVC = {"Authorization": "Bearer svc-secret"}
ANSWERS = {"why": "I run every morning", "ideas": "Hostel runs", "role": "Student"}


def verified(sub: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(sub, ev=True)}"}


@pytest.fixture
def admin(client, database) -> str:
    sub = new_sub()
    client.get("/v1/users/me/profile", headers=verified(sub))
    with database.engine.begin() as conn:
        conn.execute(User.__table__.update().where(User.auth_subject == sub).values(role="admin"))
    return sub


def user_id(client, sub) -> str:
    return client.get("/v1/users/me/profile", headers=auth(sub)).json()["user"]["id"]


def make_ambassador(client, settings, admin: str, sub: str | None = None, name: str = "Amba") -> tuple[str, str]:
    object.__setattr__(settings, "ambassador_open", True)
    sub = sub or new_sub()
    client.get("/v1/users/me/profile", headers=verified(sub))
    client.patch("/v1/users/me/profile", json={"display_name": name}, headers=verified(sub))
    app_id = client.post("/v1/ambassador/application", json={"answers": ANSWERS, "idempotency_key": "k"},
                         headers=verified(sub)).json()["id"]
    r = client.post(f"/v1/admin/ambassador/applications/{app_id}/decision", json={"status": "approved"}, headers=auth(admin))
    assert r.status_code == 200, r.text
    return sub, user_id(client, sub)


def code_of(client, sub) -> str:
    return client.get("/v1/me/membership", headers=auth(sub)).json()["referral_code"]


def refer(client, ambassador_sub: str, *, verify: bool = True, name: str = "Friend") -> tuple[str, str]:
    friend = new_sub()
    headers = verified(friend) if verify else auth(friend)
    client.get("/v1/users/me/profile", headers=headers)
    client.patch("/v1/users/me/profile", json={"display_name": name}, headers=headers)
    r = client.post("/v1/me/referral", json={"code": code_of(client, ambassador_sub)}, headers=headers)
    assert r.status_code == 200, r.text
    return friend, user_id(client, friend)


def ingest(client, sub: str, ref: str | None = None, source: str = "run_module"):
    body = {"user_subject": sub, "type": "run", "source": source, "source_ref": ref or str(uuid.uuid4()),
            "started_at": utcnow().isoformat(), "distance_m": 3000, "duration_s": 900}
    r = client.post("/internal/v1/activities", json=body, headers=SVC)
    assert r.status_code in (200, 201), r.text
    return r


def referral_awards(run_module) -> list[dict]:
    return [a for a in run_module.awards if a["reason"] == "ambassador_referral"]


def notes(client, sub) -> list[dict]:
    return client.get("/v1/notifications", headers=auth(sub)).json()["items"]


# --------------------------------------------------------------------------- profile


def test_approval_creates_the_profile_once(client, settings, admin, database):
    sub = new_sub()
    client.get("/v1/users/me/profile", headers=verified(sub))
    r = client.get("/v1/ambassador/me", headers=auth(sub))
    assert r.status_code == 404 and r.json()["code"] == "not_ambassador"
    sub, uid = make_ambassador(client, settings, admin, sub)
    me = client.get("/v1/ambassador/me", headers=auth(sub))
    assert me.status_code == 200, me.text
    body = me.json()
    assert body["status"] == "active" and body["referral_code"] == code_of(client, sub)
    assert body["invite_url"] == f"https://app.test/sign-in?mode=create&invite={body['referral_code']}"
    assert body["counts"] == {"referred": 0, "verified": 0, "activated": 0, "rewarded": 0, "referral_xp": 0, "task_xp": 0}
    # Idempotent: approving the same application again changes nothing.
    with database.SessionLocal() as db:
        app = db.scalar(select(AmbassadorApplication).where(AmbassadorApplication.user_id == uuid.UUID(uid)))
        ambassador_service.ensure_profile(db, app)
        ambassador_service.ensure_profile(db, app)
        db.commit()
    assert client.get("/v1/ambassador/me", headers=auth(sub)).json()["approved_at"] == body["approved_at"]


def test_suspend_and_reinstate(client, settings, admin):
    sub, uid = make_ambassador(client, settings, admin)
    r = client.post(f"/v1/admin/ambassadors/{uid}/suspend", json={"reason": "Spam invites"}, headers=auth(admin))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "suspended" and r.json()["suspension_reason"] == "Spam invites"
    me = client.get("/v1/ambassador/me", headers=auth(sub)).json()
    assert me["status"] == "suspended" and me["suspended_at"]
    assert client.get("/v1/ambassador/application", headers=verified(sub)).json()["application"]["status"] == "suspended"
    assert any(n["kind"] == "ambassador.suspended" for n in notes(client, sub))
    # Suspended can't re-apply their way out: the open application is returned.
    again = client.post("/v1/ambassador/application", json={"answers": ANSWERS, "idempotency_key": "k2"}, headers=verified(sub))
    assert again.json()["status"] == "suspended"
    # Suspending twice is harmless; reinstating restores both.
    assert client.post(f"/v1/admin/ambassadors/{uid}/suspend", json={"reason": "again"}, headers=auth(admin)).status_code == 200
    r = client.post(f"/v1/admin/ambassadors/{uid}/reinstate", headers=auth(admin))
    assert r.status_code == 200 and r.json()["status"] == "active" and r.json()["suspended_at"] is None
    assert client.get("/v1/ambassador/application", headers=verified(sub)).json()["application"]["status"] == "approved"
    assert client.post(f"/v1/admin/ambassadors/{uuid.uuid4()}/suspend", json={"reason": "x"}, headers=auth(admin)).status_code == 404


# --------------------------------------------------------------------------- tasks


def create_task(client, admin, **fields) -> dict:
    body = {"title": "Post a hostel run", "description": "Share a group run photo.", "xp_reward": 40, **fields}
    r = client.post("/v1/admin/ambassador/tasks", json=body, headers=auth(admin))
    assert r.status_code == 201, r.text
    return r.json()


def test_task_submit_approve_awards_xp_once(client, settings, admin, run_module):
    sub, uid = make_ambassador(client, settings, admin)
    task = create_task(client, admin)
    assert any(n["kind"] == "ambassador.task" for n in notes(client, sub))
    [listed] = client.get("/v1/ambassador/tasks", headers=auth(sub)).json()["items"]
    assert listed["id"] == task["id"] and listed["submission"] is None
    r = client.post(f"/v1/ambassador/tasks/{task['id']}/submit", json={"evidence": "https://photos.test/1"}, headers=auth(sub))
    assert r.status_code == 201, r.text
    dup = client.post(f"/v1/ambassador/tasks/{task['id']}/submit", json={"evidence": "again"}, headers=auth(sub))
    assert dup.status_code == 409 and dup.json()["code"] == "already_submitted"
    assert client.get("/v1/ambassador/tasks", headers=auth(sub)).json()["items"][0]["submission"]["status"] == "submitted"

    [sub_row] = client.get("/v1/admin/ambassador/submissions?status=submitted", headers=auth(admin)).json()["items"]
    assert sub_row["evidence"] == "https://photos.test/1" and sub_row["task"]["id"] == task["id"]
    r = client.post(f"/v1/admin/ambassador/submissions/{sub_row['id']}/decision", json={"status": "approved"}, headers=auth(admin))
    assert r.status_code == 200 and r.json()["status"] == "approved"
    again = client.post(f"/v1/admin/ambassador/submissions/{sub_row['id']}/decision", json={"status": "approved"}, headers=auth(admin))
    assert again.status_code == 409

    tasks = [a for a in run_module.awards if a["reason"] == "ambassador_task"]
    assert tasks == [{"subject": sub, "amount": 40, "reason": "ambassador_task", "source": "social",
                      "idempotency_key": f"task:{task['id']}:{uid}", "source_id": task["id"]}]
    assert run_module.xp[sub] == 40
    me = client.get("/v1/ambassador/me", headers=auth(sub)).json()
    assert me["counts"]["task_xp"] == 40
    assert len([a for a in run_module.awards if a["reason"] == "ambassador_task"]) == 1  # /me didn't re-award
    assert any(n["kind"] == "ambassador.reward" for n in notes(client, sub))
    assert client.get("/v1/admin/ambassador/submissions?status=submitted", headers=auth(admin)).json()["items"] == []


def test_rejected_submission_awards_nothing(client, settings, admin, run_module):
    sub, _ = make_ambassador(client, settings, admin)
    task = create_task(client, admin)
    sid = client.post(f"/v1/ambassador/tasks/{task['id']}/submit", json={"evidence": "x"}, headers=auth(sub)).json()["id"]
    r = client.post(f"/v1/admin/ambassador/submissions/{sid}/decision", json={"status": "rejected"}, headers=auth(admin))
    assert r.json()["status"] == "rejected" and run_module.awards == []


def test_who_can_submit(client, settings, admin):
    task = create_task(client, admin)
    stranger = new_sub()
    r = client.post(f"/v1/ambassador/tasks/{task['id']}/submit", json={"evidence": "x"}, headers=auth(stranger))
    assert r.status_code == 404 and r.json()["code"] == "not_ambassador"
    sub, uid = make_ambassador(client, settings, admin)
    client.post(f"/v1/admin/ambassadors/{uid}/suspend", json={"reason": "x"}, headers=auth(admin))
    assert client.post(f"/v1/ambassador/tasks/{task['id']}/submit", json={"evidence": "x"}, headers=auth(sub)).status_code == 403
    client.post(f"/v1/admin/ambassadors/{uid}/reinstate", headers=auth(admin))
    # Inactive / ended / unknown tasks can't be submitted.
    assert client.patch(f"/v1/admin/ambassador/tasks/{task['id']}", json={"active": False}, headers=auth(admin)).status_code == 200
    assert client.post(f"/v1/ambassador/tasks/{task['id']}/submit", json={"evidence": "x"}, headers=auth(sub)).status_code == 404
    assert client.get("/v1/ambassador/tasks", headers=auth(sub)).json()["items"] == []
    assert client.post(f"/v1/ambassador/tasks/{uuid.uuid4()}/submit", json={"evidence": "x"}, headers=auth(sub)).status_code == 404


def test_task_validation_and_patch(client, admin):
    now = utcnow()
    bad = [
        {"title": "x", "xp_reward": 0}, {"title": "x", "xp_reward": 201}, {"title": "", "xp_reward": 5},
        {"title": "   ", "xp_reward": 5}, {"xp_reward": 5}, {"title": "x" * 81, "xp_reward": 5},
        {"title": "x", "xp_reward": 5, "starts_at": now.isoformat(), "ends_at": (now - timedelta(hours=1)).isoformat()},
        {"title": "x", "xp_reward": 5, "description": "d" * 1001}, {"title": "x", "xp_reward": 5, "bogus": 1},
    ]
    for body in bad:
        assert client.post("/v1/admin/ambassador/tasks", json=body, headers=auth(admin)).status_code == 422, body
    task = create_task(client, admin)
    r = client.patch(f"/v1/admin/ambassador/tasks/{task['id']}", json={"xp_reward": 120, "title": "Bigger"}, headers=auth(admin))
    assert r.status_code == 200 and r.json()["xp_reward"] == 120 and r.json()["title"] == "Bigger"
    assert client.patch(f"/v1/admin/ambassador/tasks/{task['id']}", json={"xp_reward": 500}, headers=auth(admin)).status_code == 422
    assert client.patch(f"/v1/admin/ambassador/tasks/{task['id']}", json={"title": None}, headers=auth(admin)).status_code == 422
    past = (utcnow() - timedelta(days=400)).isoformat()
    assert client.patch(f"/v1/admin/ambassador/tasks/{task['id']}", json={"ends_at": past}, headers=auth(admin)).status_code == 422
    assert client.patch(f"/v1/admin/ambassador/tasks/{uuid.uuid4()}", json={"active": False}, headers=auth(admin)).status_code == 404


def test_submit_validation_and_rate_limit(client, settings, admin):
    sub, _ = make_ambassador(client, settings, admin)
    tasks = [create_task(client, admin, title=f"Task {i}") for i in range(11)]
    for evidence in ("", "   ", "e" * 1001):
        assert client.post(f"/v1/ambassador/tasks/{tasks[0]['id']}/submit", json={"evidence": evidence}, headers=auth(sub)).status_code == 422
    codes = [client.post(f"/v1/ambassador/tasks/{t['id']}/submit", json={"evidence": "ok"}, headers=auth(sub)).status_code
             for t in tasks]
    assert codes == [201] * 10 + [429]


# --------------------------------------------------------------------------- referrals


def test_referral_listing_is_private(client, settings, admin):
    sub, _ = make_ambassador(client, settings, admin)
    friend, friend_id = refer(client, sub, name="Kiran")
    client.patch("/v1/users/me/profile", json={"username": "kiran_secret_handle", "hostel": None}, headers=verified(friend))
    r = client.get("/v1/ambassador/referrals", headers=auth(sub))
    assert r.status_code == 200, r.text
    [item] = r.json()["items"]
    assert set(item["user"]) == {"id", "display_name", "avatar_look", "avatar_url"}
    assert item["user"]["id"] == friend_id and item["user"]["display_name"] == "Kiran"
    assert item["verified"] is True and item["activated"] is False and item["reward_eligible"] is False and item["rewarded"] is False
    assert item["signup_at"]
    text = r.text
    assert friend not in text and "kiran_secret_handle" not in text and "email" not in text and "@" not in text
    # Not an ambassador → nothing to list.
    assert client.get("/v1/ambassador/referrals", headers=auth(friend)).status_code == 404


def test_referrals_paginate(client, settings, admin):
    sub, _ = make_ambassador(client, settings, admin)
    ids = {refer(client, sub, name=f"F{i}")[1] for i in range(3)}
    first = client.get("/v1/ambassador/referrals?limit=2", headers=auth(sub)).json()
    assert len(first["items"]) == 2 and first["next_cursor"]
    second = client.get(f"/v1/ambassador/referrals?limit=2&cursor={first['next_cursor']}", headers=auth(sub)).json()
    assert len(second["items"]) == 1 and second["next_cursor"] is None
    assert {i["user"]["id"] for i in first["items"] + second["items"]} == ids
    assert client.get("/v1/ambassador/referrals?cursor=garbage", headers=auth(sub)).status_code == 422


def test_self_and_duplicate_referral_blocked(client, settings, admin, database):
    sub, uid = make_ambassador(client, settings, admin)
    other_amb, _ = make_ambassador(client, settings, admin, name="Other")
    r = client.post("/v1/me/referral", json={"code": code_of(client, sub)}, headers=verified(sub))
    assert r.status_code == 422 and r.json()["code"] == "own_code"
    friend, _ = refer(client, sub)
    r = client.post("/v1/me/referral", json={"code": code_of(client, other_amb)}, headers=verified(friend))
    assert r.status_code == 409 and r.json()["code"] == "referral_used"
    r = client.post("/v1/me/referral", json={"code": code_of(client, sub)}, headers=verified(friend))
    assert r.status_code == 409
    # The database refuses self-referral too, whatever the route does.
    import sqlalchemy.exc
    with pytest.raises(sqlalchemy.exc.IntegrityError):
        with database.engine.begin() as conn:
            conn.execute(update(Member).where(Member.user_id == uuid.UUID(uid)).values(referred_by_id=uuid.UUID(uid)))
    assert client.get("/v1/me/membership", headers=auth(sub)).json()["referrals"] == 1


def test_late_verification_counts_the_referral_once(client, settings, admin):
    sub, _ = make_ambassador(client, settings, admin)
    friend, _ = refer(client, sub, verify=False)
    assert client.get("/v1/me/membership", headers=auth(sub)).json()["referrals"] == 0
    for _ in range(3):  # verification arrives with the next token; later requests change nothing
        client.get("/v1/users/me/profile", headers=verified(friend))
    assert client.get("/v1/me/membership", headers=auth(sub)).json()["referrals"] == 1
    assert [n["kind"] for n in notes(client, sub)].count("referral") == 1
    me = client.get("/v1/ambassador/me", headers=auth(sub)).json()
    assert me["counts"]["referred"] == 1 and me["counts"]["verified"] == 1


def test_activation_makes_one_referral_reward(client, settings, admin, run_module):
    sub, _ = make_ambassador(client, settings, admin)
    friend, friend_id = refer(client, sub)
    assert referral_awards(run_module) == []  # verified, not active yet
    ingest(client, friend, ref="run-1")
    ingest(client, friend, ref="run-1")   # a re-send
    ingest(client, friend, ref="run-2")   # a second activity
    assert referral_awards(run_module) == [{"subject": sub, "amount": 50, "reason": "ambassador_referral", "source": "social",
                                            "idempotency_key": f"referral:{friend_id}", "source_id": friend_id}]
    [item] = client.get("/v1/ambassador/referrals", headers=auth(sub)).json()["items"]
    assert item["activated"] and item["reward_eligible"] and item["rewarded"]
    me = client.get("/v1/ambassador/me", headers=auth(sub)).json()["counts"]
    assert me == {"referred": 1, "verified": 1, "activated": 1, "rewarded": 1, "referral_xp": 50, "task_xp": 0}
    assert client.post("/internal/v1/tasks/ambassador-rewards", headers=SVC).status_code == 200
    assert len(referral_awards(run_module)) == 1
    assert [n["kind"] for n in notes(client, sub)].count("ambassador.reward") == 1


def test_unverified_or_late_activity_earns_nothing(client, settings, admin, run_module, database):
    sub, _ = make_ambassador(client, settings, admin)
    unverified, _ = refer(client, sub, verify=False)
    ingest(client, unverified)
    assert referral_awards(run_module) == []
    # Verifying later completes it: verified + activated.
    client.get("/v1/users/me/profile", headers=verified(unverified))
    assert len(referral_awards(run_module)) == 1
    # An activity more than 30 days after joining doesn't activate.
    late, late_id = refer(client, sub)
    with database.engine.begin() as conn:
        conn.execute(update(Member).where(Member.user_id == uuid.UUID(late_id)).values(joined_at=utcnow() - timedelta(days=31)))
    ingest(client, late)
    assert len(referral_awards(run_module)) == 1
    item = next(i for i in client.get("/v1/ambassador/referrals", headers=auth(sub)).json()["items"] if i["user"]["id"] == late_id)
    assert item["activated"] is False


def test_suspended_ambassador_gets_no_reward(client, settings, admin, run_module):
    sub, uid = make_ambassador(client, settings, admin)
    friend, _ = refer(client, sub)
    client.post(f"/v1/admin/ambassadors/{uid}/suspend", json={"reason": "Investigating"}, headers=auth(admin))
    ingest(client, friend)
    client.get("/v1/ambassador/me", headers=auth(sub))
    client.post("/internal/v1/tasks/ambassador-rewards", headers=SVC)
    assert referral_awards(run_module) == []
    [item] = client.get("/v1/ambassador/referrals", headers=auth(sub)).json()["items"]
    assert item["activated"] is True and item["reward_eligible"] is False and item["rewarded"] is False


def test_plain_member_referrals_earn_no_ambassador_xp(client, run_module):
    host = new_sub()
    client.get("/v1/users/me/profile", headers=verified(host))
    friend, _ = refer(client, host)
    ingest(client, friend)
    assert run_module.awards == []
    assert client.get("/v1/me/membership", headers=auth(host)).json()["referrals"] == 1


def test_failed_award_is_retried_and_lands_once(client, settings, admin, run_module):
    sub, _ = make_ambassador(client, settings, admin)
    friend, _ = refer(client, sub)
    run_module.award_available = False
    ingest(client, friend)  # the ingest itself still succeeds
    assert len(referral_awards(run_module)) == 1 and sub not in run_module.xp
    [item] = client.get("/v1/ambassador/referrals", headers=auth(sub)).json()["items"]
    assert item["reward_eligible"] and not item["rewarded"]
    run_module.award_available = True
    client.get("/v1/ambassador/me", headers=auth(sub))  # the next check retries
    assert len(referral_awards(run_module)) == 2 and run_module.xp[sub] == 50
    client.get("/v1/ambassador/me", headers=auth(sub))
    assert len(referral_awards(run_module)) == 2  # settled: no more calls
    assert client.get("/v1/ambassador/referrals", headers=auth(sub)).json()["items"][0]["rewarded"] is True


def test_daily_referral_reward_limit(client, settings, admin, run_module, database, monkeypatch):
    monkeypatch.setattr(ambassador_service, "REFERRAL_REWARDS_PER_DAY", 2)
    sub, uid = make_ambassador(client, settings, admin)
    for i in range(3):
        friend, _ = refer(client, sub, name=f"F{i}")
        ingest(client, friend)
    assert len(referral_awards(run_module)) == 2
    me = client.get("/v1/ambassador/me", headers=auth(sub)).json()
    assert me["counts"]["activated"] == 3 and me["counts"]["rewarded"] == 2
    # The next day the third one is rewarded on the next check.
    with database.engine.begin() as conn:
        conn.execute(update(AmbassadorReward).where(AmbassadorReward.user_id == uuid.UUID(uid))
                     .values(created_at=utcnow() - timedelta(days=1)))
    client.get("/v1/ambassador/me", headers=auth(sub))
    assert len(referral_awards(run_module)) == 3
    assert len({a["idempotency_key"] for a in referral_awards(run_module)}) == 3


def test_admin_reverses_a_reward(client, settings, admin, run_module):
    sub, uid = make_ambassador(client, settings, admin)
    friend, _ = refer(client, sub)
    ingest(client, friend)
    assert run_module.xp[sub] == 50
    [reward] = client.get(f"/v1/admin/ambassador/rewards?user_id={uid}", headers=auth(admin)).json()["items"]
    assert reward["kind"] == "referral" and reward["awarded_at"] and reward["reversed_at"] is None
    r = client.post(f"/v1/admin/ambassador/rewards/{reward['id']}/reverse", json={"reason": "Fake account"}, headers=auth(admin))
    assert r.status_code == 200 and r.json()["reversed_at"]
    assert run_module.reversals == [{"source": "social", "idempotency_key": f"referral:{reward['ref_id']}",
                                     "reason": "Fake account"}]
    assert run_module.xp[sub] == 0
    again = client.post(f"/v1/admin/ambassador/rewards/{reward['id']}/reverse", headers=auth(admin))
    assert again.status_code == 200 and len(run_module.reversals) == 1
    me = client.get("/v1/ambassador/me", headers=auth(sub)).json()["counts"]
    assert me["rewarded"] == 0 and me["referral_xp"] == 0
    # A reversed referral is never granted again.
    ingest(client, friend)
    assert len(referral_awards(run_module)) == 1
    assert client.post(f"/v1/admin/ambassador/rewards/{uuid.uuid4()}/reverse", headers=auth(admin)).status_code == 404


# --------------------------------------------------------------------------- analytics & leaderboard


def test_analytics_and_leaderboard(client, settings, admin, run_module):
    a_sub, a_id = make_ambassador(client, settings, admin, name="Asha")
    b_sub, b_id = make_ambassador(client, settings, admin, name="Bo")
    c_sub, c_id = make_ambassador(client, settings, admin, name="Cy")
    f1, _ = refer(client, a_sub)
    ingest(client, f1)
    refer(client, a_sub, verify=False)
    f3, _ = refer(client, b_sub)
    # B also earns task XP; C is suspended.
    task = create_task(client, admin, xp_reward=30)
    sid = client.post(f"/v1/ambassador/tasks/{task['id']}/submit", json={"evidence": "x"}, headers=auth(b_sub)).json()["id"]
    client.post(f"/v1/admin/ambassador/submissions/{sid}/decision", json={"status": "approved"}, headers=auth(admin))
    client.post(f"/v1/admin/ambassadors/{c_id}/suspend", json={"reason": "x"}, headers=auth(admin))

    r = client.get("/v1/admin/ambassador/referrals/analytics", headers=auth(admin))
    assert r.status_code == 200, r.text
    rows = {row["user"]["id"]: row for row in r.json()["ambassadors"]}
    assert rows[a_id]["referred"] == 2 and rows[a_id]["verified"] == 1 and rows[a_id]["activated"] == 1 and rows[a_id]["rewarded"] == 1
    assert rows[b_id]["referred"] == 1 and rows[b_id]["activated"] == 0 and rows[b_id]["task_xp"] == 30
    assert rows[c_id]["status"] == "suspended"
    assert r.json()["totals"] == {"referred": 3, "verified": 2, "activated": 1, "rewarded": 1, "referral_xp": 50, "task_xp": 30}
    assert "@" not in r.text

    board = client.get("/v1/ambassador/leaderboard", headers=auth(b_sub)).json()["entries"]
    assert [e["user"]["id"] for e in board] == [a_id, b_id]  # C is suspended
    assert board[0]["activated_referrals"] == 1 and board[1]["task_xp"] == 30 and board[1]["is_me"] is True
    assert len(client.get("/v1/ambassador/leaderboard?limit=1", headers=auth(f3)).json()["entries"]) == 1


# --------------------------------------------------------------------------- the admin guard


ADMIN_ROUTES = [
    ("post", "/v1/admin/ambassadors/{u}/suspend", {"reason": "x"}),
    ("post", "/v1/admin/ambassadors/{u}/reinstate", None),
    ("post", "/v1/admin/ambassador/tasks", {"title": "x", "xp_reward": 5}),
    ("patch", "/v1/admin/ambassador/tasks/{u}", {"active": False}),
    ("get", "/v1/admin/ambassador/submissions?status=submitted", None),
    ("post", "/v1/admin/ambassador/submissions/{u}/decision", {"status": "approved"}),
    ("get", "/v1/admin/ambassador/referrals/analytics", None),
    ("get", "/v1/admin/ambassador/rewards", None),
    ("post", "/v1/admin/ambassador/rewards/{u}/reverse", None),
]


def test_admin_routes_refuse_non_admins(client, settings, admin):
    amb, uid = make_ambassador(client, settings, admin)
    for method, path, body in ADMIN_ROUTES:
        url = path.format(u=uid)
        kwargs = {"json": body} if body is not None else {}
        assert getattr(client, method)(url, **kwargs).status_code == 401, url
        r = getattr(client, method)(url, headers=auth(amb), **kwargs)  # an ambassador isn't an admin
        assert r.status_code == 403 and r.json()["code"] == "forbidden", url


def test_admin_payload_validation(client, settings, admin):
    _, uid = make_ambassador(client, settings, admin)
    assert client.post(f"/v1/admin/ambassadors/{uid}/suspend", json={}, headers=auth(admin)).status_code == 422
    assert client.post(f"/v1/admin/ambassadors/{uid}/suspend", json={"reason": "r" * 501}, headers=auth(admin)).status_code == 422
    assert client.post("/v1/admin/ambassadors/not-a-uuid/suspend", json={"reason": "x"}, headers=auth(admin)).status_code == 422
    assert client.post(f"/v1/admin/ambassador/submissions/{uuid.uuid4()}/decision", json={"status": "maybe"}, headers=auth(admin)).status_code == 422
    assert client.post(f"/v1/admin/ambassador/submissions/{uuid.uuid4()}/decision", json={"status": "approved"}, headers=auth(admin)).status_code == 404
    assert client.get("/v1/admin/ambassador/submissions?status=bogus", headers=auth(admin)).status_code == 422
