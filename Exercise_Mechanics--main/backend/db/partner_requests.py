"""Partner Hunt Connect requests in PostgreSQL (migrations 008, 009). Used instead of partner_requests.json
whenever DATABASE_URL is set; partners/requests_store.py picks one or the other."""

from __future__ import annotations

from datetime import datetime

import psycopg

_COLUMNS = "request_id, from_user, to_user, status, created_at, expires_at, decided_at, removed_at, removed_by"


class Tx:
    """Reads and writes inside one transaction holding the caller's advisory locks."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self.conn = conn

    def rows_for(self, user_id: str) -> list[dict]:
        rows = self.conn.execute(
            f"SELECT {_COLUMNS} FROM partner_requests WHERE from_user = %s OR to_user = %s",
            (user_id, user_id)).fetchall()
        return [_row(r) for r in rows]

    def get(self, request_id: str) -> dict | None:
        row = self.conn.execute(f"SELECT {_COLUMNS} FROM partner_requests WHERE request_id = %s",
                                (request_id,)).fetchone()
        return _row(row) if row else None

    def insert(self, row: dict) -> None:
        self.conn.execute(
            f"INSERT INTO partner_requests ({_COLUMNS}) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            tuple(row.get(k) for k in _COLUMNS.split(", ")))

    def set_status(self, request_id: str, status: str, decided_at: datetime) -> None:
        self.conn.execute("UPDATE partner_requests SET status = %s, decided_at = %s WHERE request_id = %s",
                          (status, decided_at, request_id))

    def mark_removed(self, request_id: str, removed_by: str, removed_at: datetime) -> None:
        self.conn.execute("UPDATE partner_requests SET status = 'removed', removed_at = %s, removed_by = %s "
                          "WHERE request_id = %s", (removed_at, removed_by, request_id))


def lock(conn: psycopg.Connection, key: str) -> None:
    conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (key,))


def _row(values) -> dict:
    return dict(zip(_COLUMNS.split(", "), values))
