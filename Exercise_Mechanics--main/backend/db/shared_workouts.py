"""Shared workout sessions in PostgreSQL (migration 007). Used instead of one JSON file per session
whenever DATABASE_URL is set; shared_workouts/store.py picks one or the other and keeps the same shapes."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

import psycopg.errors
from psycopg.types.json import Jsonb

from backend.db.connection import pooled


class DuplicateInviteCode(Exception):
    pass


def insert(doc: dict, member_ids: list[str], closes_at: datetime) -> None:
    try:
        with pooled() as conn:
            conn.execute(
                "INSERT INTO shared_workout_sessions (session_id, invite_code, member_ids, closes_at, doc) "
                "VALUES (%s, %s, %s, %s, %s)",
                (doc["session_id"], doc["invite_code"], member_ids, closes_at, Jsonb(doc)))
    except psycopg.errors.UniqueViolation as exc:
        raise DuplicateInviteCode from exc


def read(session_id: str) -> object | None:
    with pooled() as conn:
        row = conn.execute("SELECT doc FROM shared_workout_sessions WHERE session_id = %s", (session_id,)).fetchone()
    return row[0] if row else None


def session_id_for_code(code: str) -> str | None:
    with pooled() as conn:
        row = conn.execute("SELECT session_id FROM shared_workout_sessions WHERE invite_code = %s", (code,)).fetchone()
    return row[0] if row else None


def update(session_id: str, change: Callable[[dict], tuple[dict, list[str], datetime, object]]) -> object | None:
    """Read the document under a row lock, let `change` return (new doc, member ids, closes_at,
    result), write it back and return the result. None when there is no such session. `change` may
    raise to leave the row untouched."""
    with pooled() as conn:
        row = conn.execute("SELECT doc FROM shared_workout_sessions WHERE session_id = %s FOR UPDATE",
                           (session_id,)).fetchone()
        if row is None:
            return None
        doc, member_ids, closes_at, result = change(row[0])
        conn.execute(
            "UPDATE shared_workout_sessions SET doc = %s, member_ids = %s, closes_at = %s, updated_at = now() "
            "WHERE session_id = %s",
            (Jsonb(doc), member_ids, closes_at, session_id))
    return result


def open_for(user_id: str, now: datetime) -> list[object]:
    """Documents of sessions where `user_id` still holds a seat and which may still be in play."""
    with pooled() as conn:
        rows = conn.execute(
            "SELECT doc FROM shared_workout_sessions WHERE %s = ANY(member_ids) AND closes_at > %s",
            (user_id, now)).fetchall()
    return [row[0] for row in rows]


def due_for_completion(now: datetime, limit: int) -> list[object]:
    """Documents of started races past closes_at that were never settled (completed_at present and
    null; documents from before settling existed have no such key and are left alone)."""
    with pooled() as conn:
        rows = conn.execute(
            "SELECT doc FROM shared_workout_sessions WHERE closes_at <= %s "
            "AND jsonb_typeof(doc->'completed_at') = 'null' AND jsonb_typeof(doc->'starts_at') = 'string' "
            "ORDER BY closes_at LIMIT %s",
            (now, limit)).fetchall()
    return [row[0] for row in rows]


def delete_closed_before(cutoff: datetime) -> int:
    with pooled() as conn:
        return conn.execute("DELETE FROM shared_workout_sessions WHERE closes_at < %s", (cutoff,)).rowcount
