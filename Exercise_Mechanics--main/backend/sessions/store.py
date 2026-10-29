"""Atomic minimal-session persistence and setup/training identity validation."""

from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from backend.config import user_dir
from backend.core.ids import is_valid_user_id
from backend.users.store import read_profile
from backend.workouts.catalog import load_catalog

SESSION_FILENAME = "session.json"
_SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_EXERCISE_RE = re.compile(r"^[a-z0-9_]{1,40}$")


class SessionAccessError(ValueError):
    """A setup/training identity does not refer to its persisted session plan."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class SessionAccess:
    user_id: str
    session_id: str
    exercise_id: str
    set_no: int
    record: dict


def is_valid_session_id(raw: str | None) -> bool:
    return bool(raw and _SESSION_RE.fullmatch(raw))


def _session_id(now: datetime) -> str:
    stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{stamp}-{uuid.uuid4().hex[:10]}"


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write JSON in the destination directory and atomically replace the final path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def create_session_record(
    user_id: str,
    plan: dict,
    skill_level: str,
    *,
    now: datetime | None = None,
    time_zone: str | None = None,
) -> dict:
    """Create one collision-safe session directory and atomically persist ``session.json``."""
    created = now or datetime.now(timezone.utc)
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    sessions_dir = user_dir(user_id) / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    session_dir: Path | None = None
    session_id = ""
    for _ in range(10):
        session_id = _session_id(created)
        candidate = sessions_dir / session_id
        try:
            candidate.mkdir()
        except FileExistsError:
            continue
        session_dir = candidate
        break
    if session_dir is None:
        raise RuntimeError("could not allocate a unique session id")

    record = {
        "schema_version": 1,
        "session_id": session_id,
        "user_id": user_id,
        "status": "created",
        "created_at": created.astimezone(timezone.utc).isoformat(),
        "skill_level": skill_level,
        "plan": plan,
    }
    if time_zone:
        record["timezone"] = time_zone
    try:
        _atomic_write_json(session_dir / SESSION_FILENAME, record)
    except BaseException:
        # The atomic helper removes its temporary file. Remove only our empty allocation dir.
        try:
            session_dir.rmdir()
        except OSError:
            pass
        raise
    return record


def read_session_record(user_id: str, session_id: str) -> dict | None:
    if not is_valid_user_id(user_id) or not is_valid_session_id(session_id):
        return None
    path = user_dir(user_id) / "sessions" / session_id / SESSION_FILENAME
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def validate_session_access(
    raw_user_id: str | None,
    raw_session_id: str | None,
    raw_exercise_id: str | None,
    raw_set_no: str | None,
) -> SessionAccess:
    """Resolve an exact persisted session target; never substitute a default identity."""
    if not is_valid_user_id(raw_user_id):
        raise SessionAccessError("invalid_user", "a valid user_id is required")
    user_id = str(raw_user_id)
    if read_profile(user_id) is None:
        raise SessionAccessError("user_not_found", "user not found")
    if not is_valid_session_id(raw_session_id):
        raise SessionAccessError("invalid_session", "a valid session_id is required")
    session_id = str(raw_session_id)
    if not raw_exercise_id or not _EXERCISE_RE.fullmatch(raw_exercise_id):
        raise SessionAccessError("invalid_exercise", "a valid exercise id is required")
    exercise_id = raw_exercise_id
    try:
        set_no = int(raw_set_no)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise SessionAccessError("invalid_set", "set_no must be an integer") from exc

    record = read_session_record(user_id, session_id)
    if record is None:
        raise SessionAccessError("session_not_found", "session not found")
    if record.get("user_id") != user_id:
        raise SessionAccessError("session_mismatch", "session does not belong to this user")

    catalog_entry = load_catalog().get(exercise_id)
    if catalog_entry is None:
        raise SessionAccessError("invalid_exercise", "exercise is not in the catalog")
    if not catalog_entry.enabled:
        raise SessionAccessError("exercise_unavailable", "exercise is planned but not enabled")

    plan = record.get("plan")
    if not isinstance(plan, dict) or plan.get("exercise_id") != exercise_id:
        raise SessionAccessError("exercise_mismatch", "exercise does not match the session plan")
    sets = plan.get("sets")
    if not isinstance(sets, int) or not 1 <= set_no <= sets:
        raise SessionAccessError("invalid_set", "set_no is outside the session plan")

    return SessionAccess(
        user_id=user_id,
        session_id=session_id,
        exercise_id=exercise_id,
        set_no=set_no,
        record=record,
    )
