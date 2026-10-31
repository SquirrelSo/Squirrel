"""Squirrel Dates: suggestion only, opt-in both ways, blocks both ways, zone-level data only."""

from __future__ import annotations

import dataclasses
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text, update

from app.main import create_app
from app.models import DateDismissal, ZoneVisit
from app.services import dates as svc
from app.services.route_points import SqlRoutePoints
from app.services.zones import Zone, parse_zones, zones_visited
from tests.conftest import auth, new_sub

IST = ZoneInfo("Asia/Kolkata")
LIBRARY = [22.9640, 88.5270]
TRACK = [22.9650, 88.5200]
ZONES_JSON = json.dumps([
    {"id": "library", "name": "Library", "polygon": [[LIBRARY[0] - 0.0005, LIBRARY[1] - 0.0005], [LIBRARY[0] - 0.0005, LIBRARY[1] + 0.0005],
                                                      [LIBRARY[0] + 0.0005, LIBRARY[1] + 0.0005], [LIBRARY[0] + 0.0005, LIBRARY[1] - 0.0005]]},
    {"id": "track", "name": "Sports Ground Loop", "center": TRACK, "radius_m": 100},
])
ZONES = parse_zones(ZONES_JSON)


@pytest.fixture
def settings(settings):
    return dataclasses.replace(settings, zones=ZONES)


def _evening(days_ago: int, hour: int = 18) -> datetime:
    """A local (IST) time `days_ago` days back, at `hour`:10, in UTC."""
    local = datetime.now(IST).replace(hour=hour, minute=10, second=0, microsecond=0) - timedelta(days=days_ago)
    return local.astimezone(timezone.utc)


def _points(center, at: datetime, n: int = 3):
    return [(center[0] + i * 0.00001, center[1], at + timedelta(minutes=i)) for i in range(n)]


class Runs:
    def __init__(self, client, route_points):
        self.c, self.rp, self.n = client, route_points, 0

    def run(self, sub: str, center, at: datetime, *, n_points: int = 3) -> dict:
        self.n += 1
        run_id = f"00000000-0000-4000-8000-{self.n:012d}"
        self.rp.runs[run_id] = _points(center, at, n_points)
        r = self.c.post("/internal/v1/activities", headers={"Authorization": "Bearer svc-secret"}, json={
            "user_subject": sub, "type": "run", "source": "run_module", "source_ref": run_id,
            "started_at": at.isoformat(), "distance_m": 3000, "duration_s": 1200,
        })
        assert r.status_code in (200, 201), r.text
        return r.json()


@pytest.fixture
def runs(client, route_points) -> Runs:
    return Runs(client, route_points)


def _opt(client, sub: str, on: bool = True) -> dict:
    r = client.put("/v1/dates/settings", json={"enabled": on}, headers=auth(sub))
    assert r.status_code == 200, r.text
    return r.json()


def _suggestions(client, sub: str, **params) -> dict:
    r = client.get("/v1/dates/suggestions", params=params, headers=auth(sub))
    assert r.status_code == 200, r.text
    return r.json()


def _pair(api, client, runs, center=LIBRARY):
    """Two opted-in members who each ran through `center` on two evenings."""
    a, b = new_sub(), new_sub()
    a_id, b_id = api.user(a)["id"], api.user(b)["id"]
    for sub in (a, b):
        _opt(client, sub)
        runs.run(sub, center, _evening(2))
        runs.run(sub, center, _evening(9))
    return a, b, a_id, b_id


# --------------------------------------------------------------------------- consent


def test_off_by_default_nothing_recorded_and_nothing_suggested(api, client, runs, route_points, database):
    a = new_sub()
    api.user(a)
    assert client.get("/v1/dates/settings", headers=auth(a)).json() == {"enabled": False, "zones_ready": True}
    runs.run(a, LIBRARY, _evening(1))
    assert route_points.reads == []  # a run of someone not opted in isn't even read
    with database.engine.connect() as conn:
        assert conn.execute(select(ZoneVisit)).all() == []
    body = _suggestions(client, a)
    assert body["available"] is True and body["enabled"] is False and body["suggestions"] == []
    assert "Turn on" in body["reason"]


def test_both_opted_in_get_one_suggestion_with_zone_time_and_reason(api, client, runs):
    a, b, a_id, b_id = _pair(api, client, runs)
    body = _suggestions(client, a)
    assert body["available"] and body["enabled"] and len(body["suggestions"]) == 1
    s = body["suggestions"][0]
    assert s["id"] == b_id and s["user"]["id"] == b_id
    assert s["zone"] == {"id": "library", "name": "Library"}
    assert "Library" in s["reason"] and "evenings" in s["reason"]
    when = datetime.fromisoformat(s["suggested_time"]).astimezone(IST)
    assert when.hour == 18 and when > datetime.now(IST) + timedelta(hours=2)
    assert _suggestions(client, b)["suggestions"][0]["id"] == a_id  # symmetric


def test_a_suggestion_tells_nobody_and_invites_nobody(api, client, runs):
    a, b, _, b_id = _pair(api, client, runs)
    assert _suggestions(client, a)["suggestions"]
    assert client.get("/v1/notifications", headers=auth(b)).json()["items"] == []
    assert client.post(f"/v1/dates/suggestions/{b_id}/invite", headers=auth(a)).status_code in (404, 405)
    assert client.get("/v1/notifications", headers=auth(b)).json()["items"] == []


def test_one_sided_opt_in_suggests_no_one(api, client, runs):
    a, b, _, _ = _pair(api, client, runs)
    _opt(client, b, False)
    assert _suggestions(client, a)["suggestions"] == []
    assert _suggestions(client, b)["enabled"] is False


def test_opt_out_deletes_visits_and_opt_in_scans_recent_runs(api, client, runs, database):
    a, b, a_id, b_id = _pair(api, client, runs)
    _opt(client, a, False)
    with database.engine.connect() as conn:
        owners = [str(u) for u in conn.execute(select(ZoneVisit.user_id)).scalars()]
    assert owners == [b_id, b_id]  # a's visits are gone, b's stay
    _opt(client, a, True)  # the two runs are still in Social: re-scanned, suggestion is back
    assert _suggestions(client, a)["suggestions"][0]["id"] == b_id


def test_one_visit_is_not_enough(api, client, runs):
    a, b = new_sub(), new_sub()
    api.user(a), api.user(b)
    for sub in (a, b):
        _opt(client, sub)
    runs.run(a, LIBRARY, _evening(1))
    runs.run(a, LIBRARY, _evening(3))
    runs.run(b, LIBRARY, _evening(2))
    assert _suggestions(client, a)["suggestions"] == []
    runs.run(b, LIBRARY, _evening(4))
    assert len(_suggestions(client, a)["suggestions"]) == 1


def test_different_zones_do_not_match_and_a_stray_point_is_not_a_visit(api, client, runs):
    a, b = new_sub(), new_sub()
    api.user(a), api.user(b)
    for sub in (a, b):
        _opt(client, sub)
    for d in (1, 3):
        runs.run(a, LIBRARY, _evening(d))
        runs.run(b, TRACK, _evening(d))
        runs.run(b, LIBRARY, _evening(d), n_points=1)
    assert _suggestions(client, a)["suggestions"] == []


def test_resent_run_counts_once(api, client, runs, route_points, database):
    a = new_sub()
    api.user(a)
    _opt(client, a)
    runs.run(a, LIBRARY, _evening(1))
    run_id = next(iter(route_points.runs))
    client.post("/internal/v1/activities", headers={"Authorization": "Bearer svc-secret"}, json={
        "user_subject": a, "type": "run", "source": "run_module", "source_ref": run_id,
        "started_at": _evening(1).isoformat(), "distance_m": 3100})
    with database.engine.connect() as conn:
        assert len(conn.execute(select(ZoneVisit)).all()) == 1


def test_only_param_asks_about_one_person(api, client, runs):
    a, b, _, b_id = _pair(api, client, runs)
    c = new_sub()
    c_id = api.user(c)["id"]
    assert [s["id"] for s in _suggestions(client, a, user_id=b_id)["suggestions"]] == [b_id]
    assert _suggestions(client, a, user_id=c_id)["suggestions"] == []


# --------------------------------------------------------------------------- dismiss & block


def test_maybe_later_hides_the_person_for_30_days(api, client, runs, database):
    a, b, a_id, b_id = _pair(api, client, runs)
    assert client.post(f"/v1/dates/suggestions/{b_id}/dismiss", headers=auth(a)).status_code == 204
    assert _suggestions(client, a)["suggestions"] == []
    assert _suggestions(client, b)["suggestions"][0]["id"] == a_id  # only the one who dismissed
    with database.engine.begin() as conn:
        conn.execute(update(DateDismissal).values(dismissed_at=datetime.now(timezone.utc) - timedelta(days=31)))
    assert _suggestions(client, a)["suggestions"][0]["id"] == b_id
    assert client.post("/v1/dates/suggestions/not-a-user/dismiss", headers=auth(a)).status_code == 404
    assert client.post(f"/v1/dates/suggestions/{a_id}/dismiss", headers=auth(a)).status_code == 422


def test_block_works_both_ways_and_unblock_restores(api, client, runs):
    a, b, a_id, b_id = _pair(api, client, runs)
    api.follow(a, b_id)
    api.follow(b, a_id)
    r = client.post(f"/v1/users/{b_id}/block", headers=auth(a))
    assert r.status_code == 200 and r.json() == {"user_id": b_id, "blocked": True}
    assert _suggestions(client, a)["suggestions"] == [] and _suggestions(client, b)["suggestions"] == []
    assert api.me(a)["stats"]["following"] == 0 and api.me(b)["stats"]["following"] == 0
    # the person blocked can't follow or challenge back, and isn't told why
    assert client.post(f"/v1/users/{a_id}/follow", headers=auth(b)).status_code == 404
    assert client.post("/v1/challenges", json={"opponent_id": a_id, "metric": "km", "days": 7}, headers=auth(b)).status_code == 404
    assert client.get(f"/v1/users/{b_id}/block", headers=auth(a)).json()["blocked"] is True
    assert client.get(f"/v1/users/{a_id}/block", headers=auth(b)).json()["blocked"] is False
    assert [u["id"] for u in client.get("/v1/users/me/blocks", headers=auth(a)).json()["items"]] == [b_id]
    assert client.delete(f"/v1/users/{b_id}/block", headers=auth(a)).json()["blocked"] is False
    assert _suggestions(client, a)["suggestions"][0]["id"] == b_id
    assert client.post(f"/v1/users/{a_id}/block", headers=auth(a)).status_code == 422


# --------------------------------------------------------------------------- setup & data sources


def test_without_zones_dates_is_unavailable(settings, database, run_module, storage, limiter, pushes, route_points):
    app = create_app(dataclasses.replace(settings, zones=()), database=database, run_module=run_module, storage=storage,
                     limiter=limiter, push=pushes, route_points=route_points)
    c = TestClient(app)
    sub = new_sub()
    body = c.get("/v1/dates/suggestions", headers=auth(sub)).json()
    assert body["available"] is False and "zones" in body["reason"]
    assert c.get("/v1/dates/settings", headers=auth(sub)).json()["zones_ready"] is False


def test_ingest_still_works_when_run_points_is_missing(settings, database, run_module, storage, limiter, pushes, api):
    # Social on its own database: no run_points table. The run is recorded; it just has no zones.
    app = create_app(settings, database=database, run_module=run_module, storage=storage, limiter=limiter, push=pushes,
                     route_points=SqlRoutePoints())
    c = TestClient(app)
    sub = new_sub()
    assert c.put("/v1/dates/settings", json={"enabled": True}, headers=auth(sub)).status_code == 200
    r = c.post("/internal/v1/activities", headers={"Authorization": "Bearer svc-secret"}, json={
        "user_subject": sub, "type": "run", "source": "run_module", "source_ref": "00000000-0000-4000-8000-00000000abcd",
        "started_at": _evening(1).isoformat(), "distance_m": 2000})
    assert r.status_code == 201, r.text
    assert api.me(sub)["stats"]["activities"] == 1


def test_sql_reader_reads_the_run_modules_points(database):
    pg = database.engine.dialect.name == "postgresql"
    run_id = "00000000-0000-4000-8000-0000000000aa"
    at = _evening(1)
    with database.engine.begin() as conn:
        conn.execute(text("CREATE TABLE run_points (run_id {} NOT NULL, seq integer NOT NULL, lat double precision NOT NULL, "
                          "lng double precision NOT NULL, accuracy_m double precision, recorded_at {} NOT NULL, "
                          "PRIMARY KEY (run_id, seq))".format("uuid" if pg else "TEXT", "timestamptz" if pg else "TEXT")))
        for i, (lat, lng, t) in enumerate(_points(LIBRARY, at)):
            conn.execute(text("INSERT INTO run_points (run_id, seq, lat, lng, recorded_at) VALUES (:r, :s, :lat, :lng, :t)"),
                         {"r": run_id, "s": i, "lat": lat, "lng": lng, "t": t if pg else t.replace(tzinfo=None).isoformat()})
    try:
        with database.SessionLocal() as db:
            pts = SqlRoutePoints().points(db, run_id)
            assert len(pts) == 3 and pts[0][2] == at
            assert zones_visited(pts, ZONES) == {"library": at}
            assert SqlRoutePoints().points(db, "not-a-uuid") == []
    finally:
        with database.engine.begin() as conn:
            conn.execute(text("DROP TABLE run_points"))


# --------------------------------------------------------------------------- pure parts


def test_zone_config_is_validated():
    assert parse_zones("") == ()
    for bad in ('{"id": "x"}', '[{"id": "Bad Id", "name": "x", "center": [22, 88], "radius_m": 50}]',
                '[{"id": "a", "name": "A", "polygon": [[22, 88], [22.1, 88]]}]',
                '[{"id": "a", "name": "A", "center": [22, 88], "radius_m": 5}]',
                '[{"id": "a", "name": "A", "center": [22, 88], "radius_m": 50}, {"id": "a", "name": "B", "center": [22, 88], "radius_m": 50}]',
                '[{"id": "a", "name": "A"}]'):
        with pytest.raises(ValueError):
            parse_zones(bad)
    lib, track = ZONES
    assert lib.contains(*LIBRARY) and not lib.contains(*TRACK)
    assert track.contains(TRACK[0] + 0.0008, TRACK[1]) and not track.contains(TRACK[0] + 0.0012, TRACK[1])  # ~90 m in, ~130 m out


def test_the_suggested_time_is_the_next_shared_slot_at_a_sociable_hour():
    s = dataclasses.replace(__import__("app.config", fromlist=["Settings"]).Settings(), zones=ZONES)
    # Wednesday 2026-09-30 10:00 IST
    now = datetime(2026, 9, 30, 10, 0, tzinfo=IST).astimezone(timezone.utc)
    assert svc._next_occurrence((2, 18), s, now).astimezone(IST) == datetime(2026, 9, 30, 18, 0, tzinfo=IST)
    assert svc._next_occurrence((2, 11), s, now).astimezone(IST) == datetime(2026, 10, 7, 11, 0, tzinfo=IST)  # < 2 h away
    slot, shared = svc._best_slot({(1, 18): 2, (1, 3): 5}, {(1, 18): 1, (1, 3): 9})
    assert slot == (1, 18) and shared  # 3 AM is never suggested
    assert svc._best_slot({(0, 7): 2}, {(4, 19): 3}) == ((4, 19), False)
    assert svc._best_slot({(0, 2): 2}, {(4, 23): 3}) == (None, False)
    assert svc._reason(Zone("x", "Library", center=(0, 0), radius_m=50), (1, 18)).endswith("Tuesday evenings.")
