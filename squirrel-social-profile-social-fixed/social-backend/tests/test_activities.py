"""Exercise/Run → Activity → optional Social post, without duplicating the run."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from tests.conftest import auth, new_sub


def test_share_run_uses_run_module_numbers(api, client, run_module):
    sub = new_sub()
    api.me(sub)
    run_module.add_run(sub, "run-abc", distance_m=7200, moving_time_s=41 * 60 + 2)
    post = api.post(sub, caption="Morning run", activity={"source": "run", "run_id": "run-abc"})
    act = post["activity"]
    assert act["type"] == "run" and act["source"] == "run_module" and act["verified"] is True
    assert act["distance_km"] == 7.2 and act["duration_minutes"] == 41 and act["pace"] == "5'42\""
    assert ("run", "run-abc") in run_module.calls
    body = json.dumps(post)
    assert "geometry" not in body and "coordinates" not in body and "73.8" not in body  # no GPS leaks
    assert {b["id"] for b in api.me(sub)["badges"]} >= {"first_run", "first_post"}


def test_client_cannot_supply_run_numbers(api, client, run_module):
    sub = new_sub()
    api.me(sub)
    run_module.add_run(sub, "r1", distance_m=3000)
    r = client.post("/v1/posts", headers=auth(sub), json={"caption": "x", "activity": {"source": "run", "run_id": "r1", "distance_km": 42}})
    assert r.status_code == 422


def test_cannot_share_someone_elses_run(api, client, run_module):
    owner, thief = new_sub(), new_sub()
    api.me(owner)
    api.me(thief)
    run_module.add_run(owner, "owner-run")
    r = client.post("/v1/posts", headers=auth(thief), json={"caption": "mine now", "activity": {"source": "run", "run_id": "owner-run"}})
    assert r.status_code == 404
    # and once the owner shares it, it still isn't reusable by others
    api.post(owner, activity={"source": "run", "run_id": "owner-run"})
    r = client.post("/v1/posts", headers=auth(thief), json={"caption": "mine now", "activity": {"source": "run", "run_id": "owner-run"}})
    assert r.status_code == 404


def test_run_shared_once(api, client, run_module):
    sub = new_sub()
    api.me(sub)
    run_module.add_run(sub, "r-once")
    api.post(sub, activity={"source": "run", "run_id": "r-once"})
    r = client.post("/v1/posts", headers=auth(sub), json={"caption": "again", "activity": {"source": "run", "run_id": "r-once"}})
    assert r.status_code == 409 and r.json()["code"] == "already_shared"


def test_run_status_rules(api, client, run_module):
    sub = new_sub()
    api.me(sub)
    run_module.add_run(sub, "rej", status="rejected")
    run_module.add_run(sub, "busy", status="finishing")
    run_module.add_run(sub, "flag", status="flagged")
    post = lambda rid: client.post("/v1/posts", headers=auth(sub), json={"caption": "x", "activity": {"source": "run", "run_id": rid}})  # noqa: E731
    assert post("rej").json()["code"] == "run_rejected"
    assert post("busy").status_code == 409 and post("busy").json()["code"] == "run_processing"
    flagged = post("flag")
    assert flagged.status_code == 201 and flagged.json()["activity"]["verified"] is False


def test_run_module_outage(api, client, run_module):
    sub = new_sub()
    api.me(sub)
    run_module.add_run(sub, "r2")
    run_module.fail_with = 503
    r = client.post("/v1/posts", headers=auth(sub), json={"caption": "x", "activity": {"source": "run", "run_id": "r2"}})
    assert r.status_code == 502 and r.json()["code"] == "run_module_error"
    assert api.me(sub)["stats"]["posts"] == 0  # nothing half-written


def test_deleting_post_keeps_activity_and_allows_resharing(api, client, run_module):
    sub = new_sub()
    api.me(sub)
    run_module.add_run(sub, "r3")
    post = api.post(sub, activity={"source": "run", "run_id": "r3"})
    client.delete(f"/v1/posts/{post['id']}", headers=auth(sub))
    assert api.me(sub)["stats"]["activities"] == 1
    again = api.post(sub, activity={"source": "run", "run_id": "r3"})
    assert again["activity"]["id"] == post["activity"]["id"]  # same activity, not a duplicate


def test_manual_activities_are_unverified(api):
    sub = new_sub()
    api.me(sub)
    w = api.post(sub, caption="Push day", activity={"source": "manual", "type": "workout", "name": "Push Day", "duration_minutes": 62, "calories": 480})
    assert w["activity"] == {**w["activity"], "type": "workout", "source": "manual", "verified": False, "name": "Push Day", "duration_minutes": 62, "calories": 480, "distance_km": None}
    meal = api.post(sub, caption="bowl", activity={"source": "manual", "type": "meal", "name": "Açaí bowl"})
    assert meal["activity"]["name"] == "Açaí bowl"
    ride = api.post(sub, caption="ride", activity={"source": "manual", "type": "ride", "distance_km": 42, "duration_minutes": 96})
    assert ride["activity"]["distance_km"] == 42.0 and ride["activity"]["pace"] is None


# --------------------------------------------------------------------------- internal ingestion


def _ingest(client, **overrides):
    body = {
        "user_subject": overrides.pop("user_subject"),
        "type": "workout",
        "source": "exercise",
        "source_ref": "sess-1",
        "started_at": "2026-09-27T07:00:00+05:30",
        "name": "Squats",
        "duration_s": 900,
        "calories": 110,
        "metrics": {"reps": 45, "form_score": 82},
    } | overrides
    return client.post("/internal/v1/activities", json=body, headers={"Authorization": "Bearer svc-secret"})


def test_ingest_then_share(api, client):
    sub = new_sub()
    r = _ingest(client, user_subject=sub)
    assert r.status_code == 201 and r.json()["created"] is True
    again = _ingest(client, user_subject=sub)  # idempotent retry
    assert again.status_code == 200 and again.json() == {"activity_id": r.json()["activity_id"], "created": False}
    me = api.me(sub)  # the profile was provisioned by the ingest
    assert me["stats"]["activities"] == 1 and me["recent_activities"][0]["name"] == "Squats"
    post = api.post(sub, caption="Form coach session", activity={"source": "activity", "activity_id": r.json()["activity_id"]})
    assert post["activity"]["verified"] is True and post["activity"]["calories"] == 110


def test_resending_an_activity_updates_its_summary(api, client):
    # The Exercise backend re-sends a workout after each set: the profile shows the latest numbers.
    sub = new_sub()
    first = _ingest(client, user_subject=sub, name="Squat · 1 set", duration_s=300, calories=40)
    again = _ingest(client, user_subject=sub, name="Squat · 3 sets", duration_s=900, calories=110)
    assert again.status_code == 200 and again.json()["activity_id"] == first.json()["activity_id"]
    me = api.me(sub)
    assert me["stats"]["activities"] == 1
    latest = me["recent_activities"][0]
    assert (latest["name"], latest["duration_minutes"], latest["calories"]) == ("Squat · 3 sets", 15, 110)


def test_ingested_activity_cannot_be_shared_by_others(api, client):
    owner, other = new_sub(), new_sub()
    aid = _ingest(client, user_subject=owner).json()["activity_id"]
    api.me(other)
    r = client.post("/v1/posts", headers=auth(other), json={"caption": "x", "activity": {"source": "activity", "activity_id": aid}})
    assert r.status_code == 404
    assert _ingest(client, user_subject=other).status_code == 409  # same source_ref, different user


def test_ingest_requires_service_token(client):
    body = {"user_subject": "s", "type": "run", "source": "run_module", "source_ref": "x", "started_at": "2026-09-27T07:00:00Z"}
    assert client.post("/internal/v1/activities", json=body).status_code == 401
    assert client.post("/internal/v1/activities", json=body, headers={"Authorization": "Bearer wrong"}).status_code == 401
    # a user's JWT is not a service token
    assert client.post("/internal/v1/activities", json=body, headers=auth("s")).status_code == 401


def test_ingest_refuses_location_metrics(client):
    r = _ingest(client, user_subject=new_sub(), metrics={"route_polyline": "abc"})
    assert r.status_code == 422


def test_streak_counts_consecutive_days(api, client):
    sub = new_sub()
    now = datetime.now(timezone.utc)
    for d in (0, 1, 2, 4):
        _ingest(client, user_subject=sub, source_ref=f"s{d}", started_at=(now - timedelta(days=d)).isoformat())
    assert api.me(sub)["stats"]["streak_days"] == 3


def test_seven_day_streak_badge(api, client):
    sub = new_sub()
    now = datetime.now(timezone.utc)
    for d in range(7):
        _ingest(client, user_subject=sub, source_ref=f"d{d}", started_at=(now - timedelta(days=d)).isoformat())
    me = api.me(sub)
    assert me["stats"]["streak_days"] == 7 and "streak_7" in {b["id"] for b in me["badges"]}
