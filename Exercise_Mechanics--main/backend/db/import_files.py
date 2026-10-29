"""Copy accounts and profiles from the files under data/ into the database (migration 002).

For a server that ran before accounts moved to the database:

    python -m backend.db import-files

Idempotent: a user already in the database is left exactly as it is, so running it twice, or after
people have started using the database copy, never overwrites anything. Refresh tokens are not
copied; those users simply sign in again. Session files stay where they are.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path

from psycopg.types.json import Jsonb

from backend import config
from backend.core.ids import is_valid_user_id
from backend.db.connection import connect

log = logging.getLogger(__name__)

# Profile-data files, by the database kind they become.
_DATA_FILES = {
    "skill": config.SKILL_FILENAME,
    "fitness": "fitness.json",
    "activities": "activities.json",
    "physique": "physique.json",
    "habits": "habits.json",
    "measurements": "measurements.json",
    "consents": "consents.json",
}


@dataclass
class ImportCounts:
    profiles: int = 0
    accounts: int = 0
    data_rows: int = 0
    already_there: int = 0
    unreadable: int = 0


def _read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _credential(email: str) -> dict | None:
    digest = hashlib.sha256(email.strip().lower().encode()).hexdigest()
    return _read_json(config.AUTH_DIR / "credentials" / f"{digest}.json")


def import_files() -> ImportCounts:
    counts = ImportCounts()
    root = config.USERS_DIR
    if not root.exists():
        return counts
    with connect() as conn:
        for user_dir in sorted(p for p in root.iterdir() if p.is_dir() and is_valid_user_id(p.name)):
            user_id = user_dir.name
            profile_path = user_dir / config.PROFILE_FILENAME
            if not profile_path.exists():
                continue
            profile = _read_json(profile_path)
            if profile is None or profile.get("user_id") != user_id:
                log.warning("skipping %s: unreadable profile.json", user_id)
                counts.unreadable += 1
                continue
            with conn.transaction():
                inserted = conn.execute(
                    "INSERT INTO user_profiles (user_id, profile) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (user_id, Jsonb(profile))).rowcount
                if not inserted:
                    counts.already_there += 1
                    continue
                counts.profiles += 1
                email = profile.get("email")
                credential = _credential(email) if isinstance(email, str) and email else None
                if credential and credential.get("user_id") == user_id and credential.get("password_hash"):
                    counts.accounts += conn.execute(
                        "INSERT INTO user_accounts (user_id, email, password_hash) VALUES (%s, %s, %s) "
                        "ON CONFLICT DO NOTHING",
                        (user_id, email.strip().lower(), credential["password_hash"])).rowcount
                for kind, filename in _DATA_FILES.items():
                    document = _read_json(user_dir / filename)
                    if document is not None:
                        counts.data_rows += conn.execute(
                            "INSERT INTO user_profile_data (user_id, kind, data) VALUES (%s, %s, %s) "
                            "ON CONFLICT DO NOTHING", (user_id, kind, Jsonb(document))).rowcount
    return counts
