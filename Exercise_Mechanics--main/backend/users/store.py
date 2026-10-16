"""User persistence: the profile and the chosen skill level.

With DATABASE_URL set, both live in the database (user_profiles, and user_profile_data kind 'skill';
see db/accounts.py). Without it, in users/{user_id}/profile.json and skill.json. Either way the
user's directory still holds their sessions and calibration.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from backend.config import PROFILE_FILENAME, SKILL_FILENAME, user_dir
from backend.core.ids import slugify
from backend.db import accounts as db_accounts
from backend.db import connection

SKILLS = ("beginner", "intermediate", "advanced")


def read_profile(user_id: str) -> dict | None:
    """Load a user's saved profile.json (height, weight, …) from their directory under
    USERS_DIR (now <repo_root>/data/users), or the database. Returns None if they have no profile."""
    if connection.enabled():
        return db_accounts.read_profile(user_id)
    path = user_dir(user_id) / PROFILE_FILENAME
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def create_user_record(profile: dict) -> dict:
    """Mint a unique id (name-slug + short hash), create the user's directory, and persist
    the profile as JSON. Returns the lightweight identity the client caches. The user's
    calibrated_keypoints.json later lands in the same directory."""
    user_id = f"{slugify(profile['first_name'] + '-' + profile['last_name'])}-{uuid.uuid4().hex[:6]}"
    record = {**profile, "user_id": user_id, "created_at": datetime.now(timezone.utc).isoformat()}

    udir = user_dir(user_id)
    udir.mkdir(parents=True, exist_ok=True)
    if connection.enabled():
        db_accounts.insert_profile(user_id, record)
    else:
        with open(udir / PROFILE_FILENAME, "w") as f:
            json.dump(record, f, indent=2)

    print(f"[api] created user {user_id}")
    return {"user_id": user_id, "first_name": profile["first_name"], "last_name": profile["last_name"]}


def delete_user_record(user_id: str) -> None:
    """Undo create_user_record (a sign-up that failed part-way)."""
    if connection.enabled():
        db_accounts.delete_user(user_id)
    shutil.rmtree(user_dir(user_id), ignore_errors=True)


def write_profile(user_id: str, profile: dict) -> None:
    """Replace a user's profile atomically (a crash never leaves half a file)."""
    if connection.enabled():
        db_accounts.write_profile(user_id, profile)
        return
    path = user_dir(user_id) / PROFILE_FILENAME
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(profile, f, indent=2)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def read_skill(user_id: str) -> tuple[str, bool]:
    """Return (skill_level, configured). `configured` is whether the user has EXPLICITLY set a
    skill (skill.json exists with a valid level) — distinct from the 'beginner' fallback shown
    to a brand-new profile. The UI uses `configured` to decide 'Update' (not yet saved) vs
    'Updated' (persisted), so a fresh profile isn't wrongly shown as already-updated."""
    if connection.enabled():
        saved = db_accounts.read_data(user_id, "skill") or {}
        level = saved.get("skill_level")
        return (level, True) if level in SKILLS else ("beginner", False)
    path = user_dir(user_id) / SKILL_FILENAME
    if path.exists():
        try:
            level = json.load(open(path)).get("skill_level")
            if level in SKILLS:
                return level, True
        except (OSError, ValueError):
            pass
    return "beginner", False


def write_skill(user_id: str, level: str) -> str:
    """Persist the chosen skill level → users/{id}/skill.json (creating the dir if needed).
    An unknown level is coerced to 'beginner'. Returns the level actually written."""
    lvl = level if level in SKILLS else "beginner"
    record = {"skill_level": lvl, "updated_at": datetime.now(timezone.utc).isoformat()}
    if connection.enabled():
        db_accounts.write_data(user_id, "skill", record)
    else:
        udir = user_dir(user_id)
        udir.mkdir(parents=True, exist_ok=True)
        with open(udir / SKILL_FILENAME, "w") as f:
            json.dump(record, f, indent=2)
    print(f"[api] updated skill for {user_id}: {lvl}")
    return lvl
