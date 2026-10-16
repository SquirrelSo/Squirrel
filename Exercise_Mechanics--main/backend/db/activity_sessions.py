"""This module's rows in the shared `activity_sessions` table (Integration Contract §4).

One row per exercise session, next to its `exercise_sessions` row. The Run Module derives XP from
this table (its ADR-027), so this is how a workout earns XP and counts towards the Partner Hunt gate.

The table is the Run Module's: its migrations create it, and this module never alters it, never reads
it, and only inserts or updates its OWN rows (`source_module = 'exercise_module'`). A database where
the Run Module has not migrated yet simply has no table; the session's own row is still written.

    id            uuid5 of the session id: syncing a session again updates the same row
    type          'exercise'
    subtype       the exercise (squat, pushup, bicep_curl, high_knee)
    started_at    when the session was started
    duration_s    session length, start to the end of its last set (XP tiers are by session length)
    metrics       reps or lifts, correct %, depth, Workout Score, sets, active exercise time

Only accounts with a UUID id get a row (the column is a uuid). Old name-slug test users never do.
"""

from __future__ import annotations

import logging
import uuid

import psycopg
from psycopg.types.json import Jsonb

log = logging.getLogger(__name__)

# Fixed forever: changing it would give every session a second row.
_ID_NAMESPACE = uuid.UUID("5b0f7d0e-8f3c-4a61-9d0a-2b6c1e7a4f10")

_UPSERT = """
INSERT INTO activity_sessions
    (id, user_id, type, subtype, started_at, duration_s, intensity, calories_kcal, metrics, source_module)
VALUES
    (%(id)s, %(user_id)s, 'exercise', %(subtype)s, %(started_at)s, %(duration_s)s, NULL, %(calories_kcal)s,
     %(metrics)s, 'exercise_module')
ON CONFLICT (id) DO UPDATE SET
    subtype = EXCLUDED.subtype,
    started_at = EXCLUDED.started_at,
    duration_s = EXCLUDED.duration_s,
    calories_kcal = EXCLUDED.calories_kcal,
    metrics = EXCLUDED.metrics
WHERE activity_sessions.source_module = 'exercise_module' AND activity_sessions.user_id = EXCLUDED.user_id
"""


def activity_id(session_id: str) -> str:
    return str(uuid.uuid5(_ID_NAMESPACE, f"exercise_module/{session_id}"))


def _is_uuid(value: str) -> bool:
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def build_activity_row(session_row: dict, report: dict, time_zone: str | None = None) -> dict | None:
    """The activity_sessions row for a session, from its exercise_sessions row and its report.
    `time_zone` is the phone's (session.json): the Run Module counts the daily XP cap on that day."""
    if not _is_uuid(session_row["user_id"]):
        return None
    length = session_row["end_time"] - session_row["start_time"]
    return {
        "id": activity_id(session_row["session_id"]),
        "user_id": session_row["user_id"],
        "subtype": session_row["activity_type"],
        "started_at": session_row["start_time"],
        "duration_s": max(0, int(length.total_seconds())),
        "calories_kcal": session_row["calories_kcal"],
        "metrics": {
            **(report.get("activity_metrics") or {}),
            "sets": session_row["sets"],
            "active_time_s": session_row["duration_s"],
            "session_id": session_row["session_id"],
            **({"timezone": time_zone} if time_zone else {}),
        },
    }


def write(conn: psycopg.Connection, activity_row: dict | None) -> bool:
    """Upsert one row inside its own savepoint. Returns True when written.

    Never raises: a missing table (Run Module not migrated) or any other database error is logged and
    rolled back to the savepoint, so the caller's exercise_sessions write still commits."""
    if activity_row is None:
        return False
    try:
        with conn.transaction():
            conn.execute(_UPSERT, {**activity_row, "metrics": Jsonb(activity_row["metrics"])})
        return True
    except psycopg.errors.UndefinedTable:
        log.warning("activity_sessions does not exist yet (run the Run Module's migrations); "
                    "session %s earns no XP until it does", activity_row["metrics"]["session_id"])
    except psycopg.Error:
        log.exception("could not write activity_sessions row for session %s", activity_row["metrics"]["session_id"])
    return False
