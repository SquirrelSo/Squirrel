"""Partner Hunt persistence: a user's preferences.

With DATABASE_URL set they live in the database (partner_hunt_preferences, migration 005; see
db/partner_hunt.py), so they survive a redeploy. Without it, in the user's directory:

    data/users/<id>/partner_hunt.json    preferences (what the user asked for)

Blocks are not stored here: Social owns them (ADR-032), and Partner Hunt asks it (social_blocks.py).
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from backend import config
from backend.core.ids import is_valid_user_id
from backend.db import accounts as db_accounts
from backend.db import connection
from backend.db import partner_hunt as db_partner_hunt

log = logging.getLogger(__name__)

PREFERENCES_FILENAME = "partner_hunt.json"
SCHEMA_VERSION = 1


def read_preferences(user_id: str) -> dict | None:
    """The user's saved preferences, or None when they have none (or they are unreadable — a corrupt
    document takes the user OFF the board, which is the safe direction)."""
    if connection.enabled():
        preferences = db_partner_hunt.read_preferences(user_id)
        if preferences is not None and not isinstance(preferences, dict):
            log.warning("unreadable Partner Hunt preferences for %s; treating as not set", user_id)
            return None
        return preferences
    path = config.user_dir(user_id) / PREFERENCES_FILENAME
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
        preferences = document["preferences"]
    except (OSError, ValueError, KeyError, TypeError):
        log.warning("unreadable Partner Hunt preferences for %s; treating as not set", user_id)
        return None
    return preferences if isinstance(preferences, dict) else None


def write_preferences(user_id: str, preferences: dict) -> dict:
    if connection.enabled():
        db_partner_hunt.write_preferences(user_id, preferences)
        return preferences
    _atomic_write_json(
        config.user_dir(user_id) / PREFERENCES_FILENAME,
        {
            "schema_version": SCHEMA_VERSION,
            "preferences": preferences,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    return preferences


def list_user_ids() -> list[str]:
    """Every user with a profile. Sorted, so anything built from it is deterministic."""
    if connection.enabled():
        return [uid for uid in db_accounts.list_profile_user_ids() if is_valid_user_id(uid)]
    root = config.USERS_DIR
    if not root.exists():
        return []
    return sorted(
        entry.name
        for entry in root.iterdir()
        if entry.is_dir()
        and is_valid_user_id(entry.name)
        and (entry / config.PROFILE_FILENAME).exists()
    )


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write-then-rename, so a crash mid-write leaves the previous file rather than half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
