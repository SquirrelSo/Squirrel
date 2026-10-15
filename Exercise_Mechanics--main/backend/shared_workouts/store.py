"""Shared workout persistence. With DATABASE_URL set, sessions live in shared_workout_sessions
(migration 007; db/shared_workouts.py), one row per session, changed under a row lock. Without it:

    data/shared_workouts/<session_id>.json    {doc, member_ids, closes_at}

changed under one in-process lock (Exercise runs a single worker). Either way the caller sees the
same document (model.py) and the same calls.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path

from backend import config
from backend.db import connection
from backend.db import shared_workouts as db_sessions
from backend.shared_workouts import model
from backend.shared_workouts.policy import KEEP_CLOSED_S

log = logging.getLogger(__name__)

DuplicateInviteCode = db_sessions.DuplicateInviteCode

_lock = threading.RLock()


def insert(doc: dict) -> None:
    """Raises DuplicateInviteCode when the code is taken (the caller draws another)."""
    if connection.enabled():
        db_sessions.insert(doc, model.member_ids(doc), model.closes_at(doc))
        return
    with _lock:
        if session_id_for_code(doc["invite_code"]) is not None:
            raise DuplicateInviteCode
        _write(doc)


def read(session_id: str) -> dict | None:
    if connection.enabled():
        doc = db_sessions.read(session_id)
        return doc if isinstance(doc, dict) else None
    record = _read_file(_path(session_id))
    return record["doc"] if record else None


def session_id_for_code(code: str) -> str | None:
    if connection.enabled():
        return db_sessions.session_id_for_code(code)
    with _lock:
        for record in _all_files():
            if record["doc"]["invite_code"] == code:
                return record["doc"]["session_id"]
    return None


def update(session_id: str, change: Callable[[dict], object]) -> tuple[dict, object] | None:
    """Apply `change` to the stored document (it edits the dict in place and returns a result) and
    save it, all under a lock. Returns (document, result), or None when there is no such session.
    If `change` raises, nothing is saved."""
    def apply(doc: dict) -> tuple[dict, list[str], datetime, object]:
        result = change(doc)
        return doc, model.member_ids(doc), model.closes_at(doc), (doc, result)

    if connection.enabled():
        return db_sessions.update(session_id, apply)
    with _lock:
        record = _read_file(_path(session_id))
        if record is None:
            return None
        doc = record["doc"]
        _, _, _, out = apply(doc)
        _write(doc)
        return out


def open_for(user_id: str, now: datetime) -> list[dict]:
    """Sessions in which `user_id` still holds a seat and that may still be in play (the caller
    checks the phase)."""
    if connection.enabled():
        return [doc for doc in db_sessions.open_for(user_id, now) if isinstance(doc, dict)]
    with _lock:
        return [r["doc"] for r in _all_files()
                if user_id in r["member_ids"] and model.parse(r["closes_at"]) > now]


def due_for_completion(now: datetime, limit: int) -> list[dict]:
    """Races (started) whose last moment for rep reports has passed and that were never settled, so
    the background sweep can settle races nobody is looking at any more. The caller re-checks."""
    if connection.enabled():
        return [doc for doc in db_sessions.due_for_completion(now, limit) if isinstance(doc, dict)]
    with _lock:
        docs = [r["doc"] for r in _all_files() if model.parse(r["closes_at"]) <= now]
    return [d for d in docs if "completed_at" in d and d["completed_at"] is None
            and d.get("starts_at") is not None][:limit]


def prune(now: datetime) -> int:
    """Delete sessions that closed more than KEEP_CLOSED_S ago (they carry names and photos)."""
    cutoff = now - timedelta(seconds=KEEP_CLOSED_S)
    if connection.enabled():
        return db_sessions.delete_closed_before(cutoff)
    removed = 0
    with _lock:
        for record in _all_files():
            if model.parse(record["closes_at"]) < cutoff:
                _path(record["doc"]["session_id"]).unlink(missing_ok=True)
                removed += 1
    return removed


# --- files -----------------------------------------------------------------------------------------

def _path(session_id: str) -> Path:
    return config.SHARED_WORKOUTS_DIR / f"{session_id}.json"


def _read_file(path: Path) -> dict | None:
    try:
        with open(path, encoding="utf-8") as handle:
            record = json.load(handle)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        log.warning("unreadable shared workout file %s; ignored", path.name)
        return None
    return record if isinstance(record, dict) and isinstance(record.get("doc"), dict) else None


def _all_files() -> list[dict]:
    root = config.SHARED_WORKOUTS_DIR
    if not root.exists():
        return []
    return [r for r in (_read_file(p) for p in sorted(root.glob("*.json"))) if r is not None]


def _write(doc: dict) -> None:
    record = {"doc": doc, "member_ids": model.member_ids(doc), "closes_at": model.iso(model.closes_at(doc))}
    path = _path(doc["session_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, sort_keys=True)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
