"""Mirror exercise sessions into the `exercise_sessions` table, and into the shared `activity_sessions`.

A row is derived from the session's stored files through the same report builder the API uses, so the
table always agrees with the reports: reps, sets, the Workout Score, and the member's Activity Rating.
Writes are upserts keyed by session id, so syncing the same session again just refreshes its row.
The same sync writes the session's activity_sessions row (db/activity_sessions.py), which is what earns
it XP in the Run Module.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from backend import config, social_publish
from backend.core.ids import is_valid_user_id
from backend.db import activity_sessions, connection
from backend.localtime import valid_zone
from backend.reports import builder
from backend.sessions.store import is_valid_session_id, read_session_record

log = logging.getLogger(__name__)

COLUMNS = ("session_id", "user_id", "activity_type", "start_time", "end_time", "duration_s",
           "calories_kcal", "sets", "reps", "workout_score", "activity_rating")

_UPSERT = f"""
INSERT INTO exercise_sessions ({", ".join(COLUMNS)})
VALUES ({", ".join(f"%({c})s" for c in COLUMNS)})
ON CONFLICT (session_id) DO UPDATE SET
    {", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c not in ("session_id", "user_id"))},
    updated_at = now()
WHERE exercise_sessions.user_id = EXCLUDED.user_id
"""


def build_row(user_id: str, session_id: str) -> dict | None:
    """The row for one session, or None when there is nothing to record yet (no set was started)."""
    built = _build(user_id, session_id)
    return built[0] if built else None


def _build(user_id: str, session_id: str) -> tuple[dict, dict | None] | None:
    """(exercise_sessions row, activity_sessions row or None), or None when nothing is recorded yet."""
    record = read_session_record(user_id, session_id)
    if record is None or record.get("user_id") != user_id:
        return None
    exercise_id = (record.get("plan") or {}).get("exercise_id")
    set_summaries = _set_summaries(user_id, session_id, exercise_id)
    if not exercise_id or not set_summaries:
        return None
    report = builder.build_session_report(user_id, session_id)
    if report is None:
        return None

    timed = report["measure"] == "time"
    if timed:
        duration = report["summary"]["total_time_s"]
        reps = report["summary"]["counted_lifts"]
    else:
        # Each set's own duration; older captures without it fall back to the reps' movement time.
        set_ms = [_json(p).get("set_duration_ms") for p in set_summaries]
        if all(isinstance(ms, (int, float)) for ms in set_ms):
            duration = sum(set_ms) / 1000.0
        else:
            duration = report["summary"]["total_time_s"] or 0.0
        reps = report["actual"]["reps_completed"]
    rating = report.get("activity_rating") or {}
    start = _timestamp(record.get("created_at"))
    # When the last set finished, by the server's clock (the set summary's last write).
    end = max(datetime.fromtimestamp(p.stat().st_mtime, timezone.utc) for p in set_summaries)
    row = {
        "session_id": session_id,
        "user_id": user_id,
        "activity_type": exercise_id,
        "start_time": start,
        "end_time": max(end, start),
        "duration_s": round(duration) if duration else 0,
        "calories_kcal": None,  # not calculated yet
        "sets": int(report["actual"]["sets_completed"]),
        "reps": int(reps),
        "workout_score": report["workout_score"]["score"],
        "activity_rating": rating.get("rating"),
    }
    return row, activity_sessions.build_activity_row(row, report, valid_zone(record.get("timezone")))


def upsert(conn, row: dict) -> None:
    conn.execute(_UPSERT, row)


def sync_session(user_id: str, session_id: str) -> bool:
    """Write one session's row. Returns True when a row was written. Never raises: the files are the
    source of truth, so a database problem is logged and repaired later by a backfill."""
    if not connection.enabled():
        return False
    if not (is_valid_user_id(user_id) and is_valid_session_id(session_id)):
        return False
    try:
        built = _build(user_id, session_id)
        if built is None:
            return False
        with connection.connect() as conn:
            upsert(conn, built[0])
            activity_sessions.write(conn, built[1])  # its own savepoint: never undoes the row above
        social_publish.publish(built[1])  # to the member's Social profile; background, never raises
        return True
    except Exception:  # noqa: BLE001 — a database outage must never break training or a rating
        log.exception("could not sync session %s/%s to the database", user_id, session_id)
        return False


def backfill() -> tuple[int, int]:
    """Write every stored session. Returns (rows written, sessions skipped)."""
    written = skipped = 0
    root = config.USERS_DIR
    if not root.exists():
        return 0, 0
    with connection.connect() as conn:
        for user_dir in sorted(p for p in root.iterdir() if p.is_dir() and is_valid_user_id(p.name)):
            sessions = user_dir / "sessions"
            if not sessions.is_dir():
                continue
            for session_dir in sorted(p for p in sessions.iterdir() if p.is_dir()):
                built = _build(user_dir.name, session_dir.name)
                if built is None:
                    skipped += 1
                    continue
                with conn.transaction():
                    upsert(conn, built[0])
                    activity_sessions.write(conn, built[1])
                written += 1
    return written, skipped


def _set_summaries(user_id: str, session_id: str, exercise_id: str | None) -> list:
    if not exercise_id:
        return []
    workout = config.user_dir(user_id) / "sessions" / session_id / "workouts" / exercise_id
    if not workout.is_dir():
        return []
    return sorted(workout.glob("set_*/set_summary.json"))


def _json(path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _timestamp(raw: object) -> datetime:
    moment = datetime.fromisoformat(str(raw))
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
