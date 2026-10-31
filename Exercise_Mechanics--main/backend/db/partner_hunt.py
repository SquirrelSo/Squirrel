"""Partner Hunt preferences in PostgreSQL (migration 005). Used instead of partner_hunt.json whenever
DATABASE_URL is set; partners/store.py picks one or the other and keeps the same shapes."""

from __future__ import annotations

from psycopg.types.json import Jsonb

from backend.db.connection import pooled


def read_preferences(user_id: str) -> object | None:
    """The stored preferences as they are (the caller checks the shape), or None when none are saved."""
    with pooled() as conn:
        row = conn.execute("SELECT preferences FROM partner_hunt_preferences WHERE user_id = %s",
                           (user_id,)).fetchone()
    return row[0] if row else None


def write_preferences(user_id: str, preferences: dict) -> None:
    with pooled() as conn:
        conn.execute(
            "INSERT INTO partner_hunt_preferences (user_id, preferences) VALUES (%s, %s) "
            "ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences, updated_at = now()",
            (user_id, Jsonb(preferences)))
