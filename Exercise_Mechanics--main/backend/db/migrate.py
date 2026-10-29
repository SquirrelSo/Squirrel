"""A small forward-only migration runner: numbered .sql files, each applied once, in order.

Each migration runs in its own transaction together with its bookkeeping row, and an advisory lock
keeps two app instances starting at once from applying the same file twice.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import psycopg

from backend.db import connection

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
_NAME_RE = re.compile(r"^(\d{3})_[a-z0-9_]+\.sql$")
_LOCK_KEY = 7_401_202_615  # arbitrary, fixed: "exercise mechanics migrations"


def migration_files() -> list[Path]:
    files = sorted(p for p in MIGRATIONS_DIR.iterdir() if _NAME_RE.fullmatch(p.name))
    numbers = [int(_NAME_RE.fullmatch(p.name).group(1)) for p in files]
    if numbers != list(range(1, len(numbers) + 1)):
        raise RuntimeError(f"migrations must be numbered 001, 002, … without gaps: {[p.name for p in files]}")
    return files


def migrate(conn: psycopg.Connection | None = None) -> list[str]:
    """Apply every pending migration. Returns the names applied (empty when already up to date)."""
    own = conn is None
    conn = conn or connection.connect()
    applied: list[str] = []
    try:
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(%s)", (_LOCK_KEY,))
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                " version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            done = {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}
            for path in migration_files():
                if path.name in done:
                    continue
                with conn.transaction():
                    conn.execute(path.read_text(encoding="utf-8"))
                    conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.name,))
                applied.append(path.name)
                log.info("applied migration %s", path.name)
    finally:
        if own:
            conn.close()
    return applied
