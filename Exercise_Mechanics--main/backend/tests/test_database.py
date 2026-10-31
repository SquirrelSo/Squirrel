"""PostgreSQL mirror of exercise sessions, against a real database.

Runs when TEST_DATABASE_URL points at a disposable database (its tables are dropped and recreated);
skipped otherwise, so the suite still runs where PostgreSQL isn't available.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import uuid
from datetime import datetime, timedelta

import psycopg
import pytest

from backend import config
from backend.activity_rating import store as rating_store
from backend.db import activity_sessions, exercise_sessions
from backend.db.exercise_sessions import COLUMNS, backfill, build_row, sync_session
from backend.db.migrate import migrate, migration_files
from backend.reports import builder
from backend.tests.db_reset import drop_exercise_tables
from backend.tests.test_activity_rating import _request as rating_request
from backend.tests.test_workout_score import UID, _write_session
from backend.training.router import _set_finished
from backend.workouts.catalog import load_catalog

TEST_URL = os.environ.get("TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL not set")

SID = "20260921T070000-dbtest"
REPS = [(100, 1.0), (80, 1.0), (100, 0.7), (95, 1.0), (100, 1.0)]


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path)
    monkeypatch.setenv("DATABASE_URL", TEST_URL)
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        drop_exercise_tables(conn)
    migrate()
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        yield conn


def rows(conn) -> list[dict]:
    cur = conn.execute(f"SELECT {', '.join(COLUMNS)}, updated_at FROM exercise_sessions ORDER BY session_id")
    names = [d.name for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


# ---------------------------------------------------------------- schema

def test_migrations_apply_once(db):
    assert migrate() == []  # already applied by the fixture
    versions = [r[0] for r in db.execute("SELECT version FROM schema_migrations")]
    assert versions == [p.name for p in migration_files()]


def test_the_table_holds_exercise_parameters_only():
    assert set(COLUMNS) == {"session_id", "user_id", "activity_type", "start_time", "end_time", "duration_s",
                            "calories_kcal", "sets", "reps", "workout_score", "activity_rating"}
    assert not {"distance", "distance_m", "steps", "pace", "speed"} & set(COLUMNS)


def test_activity_types_are_exactly_the_enabled_exercises(db):
    seeded = {code: measure for code, measure in db.execute("SELECT code, measure FROM activity_types")}
    assert set(seeded) == {entry.slug for entry in load_catalog().enabled()}
    assert seeded["high_knee"] == "time" and seeded["squat"] == seeded["pushup"] == seeded["bicep_curl"] == "reps"


@pytest.mark.parametrize("column,value", [
    ("workout_score", 101), ("workout_score", -1), ("activity_rating", 0), ("activity_rating", 6),
    ("activity_type", "running"), ("reps", -1), ("duration_s", -5), ("user_id", "Bad Id"),
])
def test_the_database_itself_rejects_impossible_values(db, column, value):
    row = {"session_id": "s1", "user_id": "ana-tester-abc123", "activity_type": "squat",
           "start_time": "2026-09-21T07:00:00+00:00", column: value}
    cols = ", ".join(row)
    with pytest.raises(psycopg.errors.IntegrityError):
        db.execute(f"INSERT INTO exercise_sessions ({cols}) VALUES ({', '.join(['%s'] * len(row))})", list(row.values()))


# ---------------------------------------------------------------- rows

def test_a_rep_session_becomes_one_row_matching_its_report(db):
    _write_session(config.USERS_DIR, SID, "2026-09-21T07:00:00+00:00", REPS)
    assert sync_session(UID, SID) is True
    [row] = rows(db)
    report = builder.build_session_report(UID, SID)
    assert row["session_id"] == SID and row["user_id"] == UID and row["activity_type"] == "squat"
    assert row["start_time"] == datetime.fromisoformat("2026-09-21T07:00:00+00:00")
    assert row["end_time"] >= row["start_time"]
    assert row["sets"] == 1 and row["reps"] == len(REPS)
    assert row["duration_s"] == 2 * len(REPS)  # no set duration stored: the reps' movement time (2 s each)
    assert row["workout_score"] == report["workout_score"]["score"]
    assert row["activity_rating"] is None and row["calories_kcal"] is None


def test_duration_is_each_sets_own_duration_when_recorded(db):
    _write_session(config.USERS_DIR, SID, "2026-09-21T07:00:00+00:00", REPS)
    summary = config.USERS_DIR / UID / "sessions" / SID / "workouts" / "squat" / "set_1" / "set_summary.json"
    summary.write_text(json.dumps({**json.loads(summary.read_text()), "set_duration_ms": 47_600.0}))
    sync_session(UID, SID)
    assert rows(db)[0]["duration_s"] == 48


def test_syncing_again_refreshes_the_same_row(db):
    _write_session(config.USERS_DIR, SID, "2026-09-21T07:00:00+00:00", REPS)
    sync_session(UID, SID)
    first = rows(db)[0]["updated_at"]
    sync_session(UID, SID)
    [row] = rows(db)
    assert row["updated_at"] >= first


def test_rating_a_session_updates_its_row(db):
    _write_session(config.USERS_DIR, SID, "2026-09-21T07:00:00+00:00", REPS)
    sync_session(UID, SID)
    url = f"/api/users/{UID}/sessions/{SID}/activity-rating"
    assert rating_request("PUT", url, {"rating": 4, "feeling": "good"})[0] == 200
    assert rows(db)[0]["activity_rating"] == 4
    rating_request("DELETE", url)
    assert rows(db)[0]["activity_rating"] is None
    score = rows(db)[0]["workout_score"]
    rating_request("PUT", url, {"rating": 1})
    assert rows(db)[0]["workout_score"] == score  # the member's rating never moves the system score


def test_a_timed_session_records_counted_lifts_and_active_time(db):
    session_dir = config.USERS_DIR / UID / "sessions" / "20260921T080000-timed"
    set_dir = session_dir / "workouts" / "high_knee" / "set_1"
    set_dir.mkdir(parents=True)
    (session_dir / "session.json").write_text(json.dumps({
        "created_at": "2026-09-21T08:00:00+00:00", "session_id": "20260921T080000-timed", "user_id": UID,
        "plan": {"exercise_id": "high_knee", "exercise_name": "High Knees", "sets": 1,
                 "target": {"type": "time", "value_ms": 30000}, "metadata": {}}}))
    (set_dir / "set_summary.json").write_text(json.dumps({
        "status": "complete", "counted_lifts": 24, "full_lifts": 20, "shallow_lifts": 4,
        "score": {"score": 81.0, "form_factor": 0.9, "rom_factor": 0.9, "quality": "reliable"},
        "monitors": {"left_right_asymmetry": {"status": "balanced"}}}))
    assert sync_session(UID, "20260921T080000-timed") is True
    [row] = rows(db)
    assert row["activity_type"] == "high_knee" and row["reps"] == 24 and row["sets"] == 1
    assert row["duration_s"] == 30 and row["workout_score"] is not None


def test_a_session_with_no_sets_yet_is_not_recorded(db):
    session_dir = config.USERS_DIR / UID / "sessions" / "20260921T090000-empty"
    session_dir.mkdir(parents=True)
    (session_dir / "session.json").write_text(json.dumps({
        "created_at": "2026-09-21T09:00:00+00:00", "user_id": UID,
        "plan": {"exercise_id": "squat", "sets": 3, "target": {"type": "reps", "value": 10}}}))
    assert build_row(UID, "20260921T090000-empty") is None
    assert sync_session(UID, "20260921T090000-empty") is False and rows(db) == []


def test_backfill_writes_every_stored_session(db):
    _write_session(config.USERS_DIR, SID, "2026-09-21T07:00:00+00:00", REPS)
    _write_session(config.USERS_DIR, "20260922T070000-second", "2026-09-22T07:00:00+00:00", REPS[:3])
    (config.USERS_DIR / UID / "sessions" / "20260923T070000-empty").mkdir()
    assert backfill() == (2, 1)
    assert [r["session_id"] for r in rows(db)] == [SID, "20260922T070000-second"]
    assert backfill() == (2, 1) and len(rows(db)) == 2  # idempotent


def test_one_members_sync_never_overwrites_anothers_row(db):
    _write_session(config.USERS_DIR, SID, "2026-09-21T07:00:00+00:00", REPS)
    sync_session(UID, SID)
    row = build_row(UID, SID)
    exercise_sessions.upsert(db, {**row, "user_id": "someone-else-123456", "reps": 999})
    assert rows(db)[0]["user_id"] == UID and rows(db)[0]["reps"] == len(REPS)


# ---------------------------------------------------------------- shared activity_sessions (XP)

# The Run Module's table, as its migration 002 creates it. Created here only so these tests run without
# the Node migrations; in a deployment the Run Module creates it and this module never does.
_RUN_MODULE_ACTIVITY_SESSIONS = """
CREATE TABLE activity_sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, type text NOT NULL, subtype text NOT NULL,
  started_at timestamptz NOT NULL, duration_s integer NOT NULL, intensity text, calories_kcal numeric,
  metrics jsonb NOT NULL, source_module text NOT NULL DEFAULT 'run_module',
  created_at timestamptz NOT NULL DEFAULT now())
"""
ACCOUNT = "3f0c6a52-6a8e-4c1e-9b1a-6f0e2d9c4b11"


@pytest.fixture
def shared(db):
    db.execute("DROP TABLE IF EXISTS activity_sessions")
    db.execute(_RUN_MODULE_ACTIVITY_SESSIONS)
    yield db
    db.execute("DROP TABLE IF EXISTS activity_sessions")


def activity_rows(conn) -> list[dict]:
    cur = conn.execute("SELECT * FROM activity_sessions ORDER BY started_at")
    names = [d.name for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def _account_session(sid: str, started: datetime, minutes: float) -> None:
    """A squat session for an account (UUID id) whose last set ended `minutes` after it started."""
    _write_session(config.USERS_DIR, sid, started.isoformat(), REPS)
    shutil.move(config.USERS_DIR / UID / "sessions" / sid, config.USERS_DIR / ACCOUNT / "sessions" / sid)
    session_file = config.USERS_DIR / ACCOUNT / "sessions" / sid / "session.json"
    session_file.write_text(json.dumps({**json.loads(session_file.read_text()), "user_id": ACCOUNT}))
    ended = (started + timedelta(minutes=minutes)).timestamp()
    os.utime(config.USERS_DIR / ACCOUNT / "sessions" / sid / "workouts" / "squat" / "set_1" / "set_summary.json",
             (ended, ended))


def test_an_account_session_writes_one_activity_row_for_xp(shared):
    started = datetime.fromisoformat("2026-09-21T07:00:00+00:00")
    _account_session(SID, started, minutes=25)
    assert sync_session(ACCOUNT, SID) is True
    [row] = activity_rows(shared)
    assert str(row["id"]) == activity_sessions.activity_id(SID)
    assert str(row["user_id"]) == ACCOUNT
    assert (row["type"], row["subtype"], row["source_module"]) == ("exercise", "squat", "exercise_module")
    assert row["started_at"] == started
    assert row["duration_s"] == 25 * 60  # the session's length (XP no longer uses it: reps do)
    metrics = row["metrics"]
    assert metrics["reps"] == len(REPS) and metrics["sets"] == 1 and metrics["session_id"] == SID
    assert metrics["active_time_s"] == rows(shared)[0]["duration_s"]  # active exercise time, kept too
    assert metrics["workout_score"] == rows(shared)[0]["workout_score"]
    assert row["calories_kcal"] is None and row["intensity"] is None
    sync_session(ACCOUNT, SID)  # syncing again updates the same row
    assert len(activity_rows(shared)) == 1


def test_the_activity_row_carries_the_phones_time_zone(shared):
    _account_session(SID, datetime.fromisoformat("2026-09-21T19:00:00+00:00"), minutes=25)
    session_file = config.USERS_DIR / ACCOUNT / "sessions" / SID / "session.json"
    session_file.write_text(json.dumps({**json.loads(session_file.read_text()), "timezone": "Asia/Kolkata"}))
    sync_session(ACCOUNT, SID)
    [row] = activity_rows(shared)
    assert row["metrics"]["timezone"] == "Asia/Kolkata"  # the Run Module's XP day follows it


def test_only_accounts_get_activity_rows(shared):
    _write_session(config.USERS_DIR, SID, "2026-09-21T07:00:00+00:00", REPS)
    assert sync_session(UID, SID) is True  # a name-slug test user: its session row, but no XP row
    assert len(rows(shared)) == 1 and activity_rows(shared) == []


def test_it_never_changes_a_row_it_does_not_own(shared):
    _account_session(SID, datetime.fromisoformat("2026-09-21T07:00:00+00:00"), minutes=25)
    run = {"id": activity_sessions.activity_id(SID), "user_id": ACCOUNT}
    shared.execute("INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics)"
                   " VALUES (%(id)s, %(user_id)s, 'run', 'territory_run', now(), 60, '{}')", run)
    sync_session(ACCOUNT, SID)
    [row] = activity_rows(shared)
    assert row["type"] == "run" and row["source_module"] == "run_module" and row["duration_s"] == 60
    assert len(rows(shared)) == 1  # the session's own row is still written


def test_backfill_writes_the_activity_rows_too(shared):
    _account_session(SID, datetime.fromisoformat("2026-09-21T07:00:00+00:00"), minutes=12)
    _account_session("20260922T070000-second", datetime.fromisoformat("2026-09-22T07:00:00+00:00"), minutes=50)
    assert backfill() == (2, 0)
    assert [r["duration_s"] for r in activity_rows(shared)] == [12 * 60, 50 * 60]
    assert backfill() == (2, 0) and len(activity_rows(shared)) == 2


def test_without_the_run_modules_table_the_session_row_is_still_written(db, caplog):
    db.execute("DROP TABLE IF EXISTS activity_sessions")
    _account_session(SID, datetime.fromisoformat("2026-09-21T07:00:00+00:00"), minutes=25)
    with caplog.at_level(logging.WARNING):
        assert sync_session(ACCOUNT, SID) is True
    assert len(rows(db)) == 1
    assert "activity_sessions does not exist yet" in caplog.text


# ---------------------------------------------------------------- failure never breaks the app

def test_without_database_url_everything_is_a_no_op(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    _write_session(tmp_path, SID, "2026-09-21T07:00:00+00:00", REPS)
    assert sync_session(UID, SID) is False


def test_a_database_that_is_down_is_logged_not_raised(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path)
    monkeypatch.setenv("DATABASE_URL", "postgresql://nobody:nothing@127.0.0.1:1/none")
    _write_session(tmp_path, SID, "2026-09-21T07:00:00+00:00", REPS)
    assert sync_session(UID, SID) is False
    assert "could not sync session" in caplog.text
    # and the rating endpoint still saves the rating to disk
    assert rating_request("PUT", f"/api/users/{UID}/sessions/{SID}/activity-rating", {"rating": 5})[0] == 200
    assert rating_store.read_rating(UID, SID)["rating"] == 5


def test_the_app_migrates_on_startup(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", TEST_URL)
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        drop_exercise_tables(conn)
    from backend.main import _lifespan, app

    async def start_and_stop():
        async with _lifespan(app):
            pass
    asyncio.run(start_and_stop())
    with psycopg.connect(TEST_URL) as conn:
        assert conn.execute("SELECT count(*) FROM activity_types").fetchone()[0] == 4


# ---------------------------------------------------------------- when training triggers a sync

@pytest.mark.parametrize("data,expected", [
    ({"events": {"set_cycle_completed": True}}, True),                 # rep exercises
    ({"events": {"set_completed": True, "lift_cycles": []}}, True),   # high knees
    ({"events": {"set_cycle_completed": False, "rep_cycle_completed": True}}, False),
    ({"events": {"set_completed": False}, "set": {"complete": True}}, False),  # after completion
    ({"set": {"complete": True}}, False),
    ({}, False),
])
def test_only_the_status_that_closes_a_set_triggers_a_sync(data, expected):
    assert _set_finished(data) is expected
