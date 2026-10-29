"""Partner Hunt Connect persistence: requests between members.

With DATABASE_URL set they live in partner_requests (migration 008; db/partner_requests.py). Without
it, in one file, changed under one in-process lock (Exercise runs a single worker):

    data/partner_hunt/requests.json    {"requests": [row…]}

A row: {request_id, from_user, to_user, status, created_at, expires_at, decided_at, removed_at,
removed_by}, times as datetimes (removed_* are set only on a connection someone removed; older file
rows may lack them). Every read-check-write runs inside `transaction(...)`, so two requests between the same
people, or a burst from one sender, can't both slip past the limits.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from backend import config
from backend.db import connection
from backend.db import partner_requests as db_requests
from backend.db.connection import pooled

_TIMES = ("created_at", "expires_at", "decided_at", "removed_at")
_lock = threading.RLock()


@contextmanager
def transaction(*lock_keys: str) -> Iterator[object]:
    """A transaction holding the named locks (in the order given). Yields an object with
    rows_for(user_id), get(request_id), insert(row), set_status(request_id, status, decided_at) and
    mark_removed(request_id, removed_by, removed_at)."""
    if connection.enabled():
        with pooled() as conn:
            for key in lock_keys:
                db_requests.lock(conn, key)
            yield db_requests.Tx(conn)
        return
    with _lock:
        tx = _FileTx(_load())
        yield tx
        if tx.dirty:
            _save(tx.rows)


def get(request_id: str) -> dict | None:
    with transaction() as tx:
        return tx.get(request_id)


def rows_for(user_id: str) -> list[dict]:
    with transaction() as tx:
        return tx.rows_for(user_id)


class _FileTx:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.dirty = False

    def rows_for(self, user_id: str) -> list[dict]:
        return [dict(r) for r in self.rows if user_id in (r["from_user"], r["to_user"])]

    def get(self, request_id: str) -> dict | None:
        return next((dict(r) for r in self.rows if r["request_id"] == request_id), None)

    def insert(self, row: dict) -> None:
        self.rows.append(dict(row))
        self.dirty = True

    def set_status(self, request_id: str, status: str, decided_at: datetime) -> None:
        for r in self.rows:
            if r["request_id"] == request_id:
                r["status"], r["decided_at"] = status, decided_at
                self.dirty = True

    def mark_removed(self, request_id: str, removed_by: str, removed_at: datetime) -> None:
        for r in self.rows:
            if r["request_id"] == request_id:
                r["status"], r["removed_at"], r["removed_by"] = "removed", removed_at, removed_by
                self.dirty = True


def _path() -> Path:
    return config.PARTNER_REQUESTS_FILE


def _load() -> list[dict]:
    try:
        with open(_path(), encoding="utf-8") as handle:
            rows = json.load(handle)["requests"]
    except FileNotFoundError:
        return []
    return [{k: (datetime.fromisoformat(v) if k in _TIMES and v else v) for k, v in r.items()} for r in rows]


def _save(rows: list[dict]) -> None:
    payload = {"requests": [{k: (v.isoformat() if k in _TIMES and v else v) for k, v in r.items()} for r in rows]}
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
