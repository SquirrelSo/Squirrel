"""Credential + refresh-token persistence.

With DATABASE_URL set (production, Supabase): the user_accounts, user_refresh_tokens and user_profiles
tables (db/accounts.py, migration 002).

Without it (local development and most tests), files under config.AUTH_DIR (never under version control):
    credentials/<sha256(email)>.json   {user_id, password_hash, created_at}
    refresh/<sha256(token)>.json       {user_id, expires_at}
The email is hashed in the file name so the directory listing is not an address book; the account
profile itself lives in the ordinary users/<id>/profile.json.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from backend import config
from backend.auth.tokens import hash_password, new_refresh_token, token_digest
from backend.config import PROFILE_FILENAME, user_dir
from backend.db import accounts as db_accounts
from backend.db import connection


class EmailTaken(Exception):
    pass


def normalize_email(email: str) -> str:
    return email.strip().lower()


def normalize_signup_email(email: str) -> str:
    """Canonical Gmail mailbox key for signup collision checks only."""
    value = normalize_email(email)
    local, separator, domain = value.rpartition("@")
    if separator and domain in {"gmail.com", "googlemail.com"}:
        local = local.split("+", 1)[0].replace(".", "")
        return f"{local}@gmail.com"
    return value


def signup_email_taken(email: str) -> bool:
    """Compare a signup address against existing addresses using Gmail alias rules on both sides.

    This intentionally does not change normalize_email or existing account lookups.
    """
    canonical = normalize_signup_email(email)
    if not canonical.endswith("@gmail.com"):
        return read_credential(canonical) is not None
    if connection.enabled():
        return db_accounts.gmail_alias_exists(canonical)
    profiles = config.USERS_DIR.glob(f"*/{PROFILE_FILENAME}")
    for path in profiles:
        try:
            with open(path, encoding="utf-8") as profile_file:
                stored_email = json.load(profile_file).get("email")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(stored_email, str) and normalize_signup_email(stored_email) == canonical:
            return True
    return False


def read_credential_for_email_code(email: str) -> dict | None:
    """Resolve email-code sign-in exactly first, then a unique Gmail mailbox alias."""
    exact = read_credential(email)
    if exact is not None:
        return exact
    normalized = normalize_email(email)
    _, separator, domain = normalized.rpartition("@")
    if not separator or domain not in {"gmail.com", "googlemail.com"}:
        return None
    canonical = normalize_signup_email(normalized)
    if connection.enabled():
        matches = db_accounts.gmail_alias_credentials(canonical)
    else:
        matches_by_id: dict[str, dict] = {}
        for path in config.USERS_DIR.glob(f"*/{PROFILE_FILENAME}"):
            try:
                with open(path, encoding="utf-8") as profile_file:
                    stored_email = json.load(profile_file).get("email")
            except (OSError, ValueError, AttributeError):
                continue
            if not isinstance(stored_email, str) or normalize_signup_email(stored_email) != canonical:
                continue
            credential = read_credential(stored_email)
            if credential is not None:
                matches_by_id[credential["user_id"]] = credential
        matches = list(matches_by_id.values())
    return matches[0] if len(matches) == 1 else None


def _credential_path(email: str) -> Path:
    return config.AUTH_DIR / "credentials" / f"{hashlib.sha256(normalize_email(email).encode()).hexdigest()}.json"


def _refresh_path(token: str) -> Path:
    return config.AUTH_DIR / "refresh" / f"{token_digest(token)}.json"


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def register_account(email: str, password: str, first_name: str, last_name: str,
                     profile: dict | None = None, *, email_verified: bool = False) -> str:
    """Create the credential and the account's profile. Raises EmailTaken on a duplicate.

    `profile` carries any further sign-up fields (gender, height, date of birth, …), stored in the
    same profile.json. All or nothing: if the profile can't be written, the credential is removed
    so the email can be used again."""
    # A UUID: the Run Module only accepts UUID subjects, and it is also a valid id here
    # ([a-z0-9-], 36 characters), so the same account works on both backends.
    user_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    profile_doc = {
        **(profile or {}),
        "user_id": user_id,
        "first_name": first_name,
        "last_name": last_name,
        "email": normalize_email(email),
        "created_at": created_at,
    }
    if email_verified:
        profile_doc["email_verified_at"] = created_at
    if connection.enabled():
        try:
            db_accounts.create_account(user_id, normalize_email(email), hash_password(password), profile_doc)
        except db_accounts.EmailTaken:
            raise EmailTaken(email) from None
        user_dir(user_id).mkdir(parents=True, exist_ok=True)  # sessions and calibration still live here
        return user_id

    cred_path = _credential_path(email)
    cred_path.parent.mkdir(parents=True, exist_ok=True)
    record = {"user_id": user_id, "password_hash": hash_password(password), "created_at": created_at}
    # O_EXCL makes the email claim atomic: two concurrent registrations cannot both win.
    try:
        fd = os.open(cred_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise EmailTaken(email) from None
    with os.fdopen(fd, "w") as f:
        json.dump(record, f, indent=2)

    try:
        udir = user_dir(user_id)
        udir.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(udir / PROFILE_FILENAME, profile_doc)
    except BaseException:
        cred_path.unlink(missing_ok=True)
        shutil.rmtree(user_dir(user_id), ignore_errors=True)
        raise
    return user_id


def delete_account(email: str, user_id: str) -> None:
    """Undo register_account (used when a later step of sign-up fails)."""
    if connection.enabled():
        db_accounts.delete_user(user_id)
        shutil.rmtree(user_dir(user_id), ignore_errors=True)
        return
    _credential_path(email).unlink(missing_ok=True)
    shutil.rmtree(user_dir(user_id), ignore_errors=True)


def read_credential(email: str) -> dict | None:
    if connection.enabled():
        return db_accounts.read_credential(normalize_email(email))
    path = _credential_path(email)
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def issue_refresh_token(user_id: str, now: float | None = None) -> tuple[str, int]:
    token = new_refresh_token()
    expires_at = int((now if now is not None else time.time()) + config.REFRESH_TOKEN_TTL_SECONDS)
    if connection.enabled():
        db_accounts.store_refresh_token(token_digest(token), user_id, expires_at)
        return token, expires_at
    _atomic_write_json(_refresh_path(token), {"user_id": user_id, "expires_at": expires_at})
    return token, expires_at


def consume_refresh_token(token: str, now: float | None = None) -> str | None:
    """Single-use: delete the stored token and return its user id if it was valid."""
    if connection.enabled():
        return db_accounts.consume_refresh_token(token_digest(token), now if now is not None else time.time())
    path = _refresh_path(token)
    try:
        with open(path) as f:
            record = json.load(f)
        path.unlink()
    except (FileNotFoundError, ValueError):
        return None
    if record.get("expires_at", 0) <= (now if now is not None else time.time()):
        return None
    return record.get("user_id")


def email_verified(user_id: str) -> bool:
    """Whether the account proved its email address at sign-up (auth/email_codes.py)."""
    if connection.enabled():
        profile = db_accounts.read_profile(user_id)
    else:
        try:
            with open(user_dir(user_id) / PROFILE_FILENAME) as f:
                profile = json.load(f)
        except (FileNotFoundError, ValueError):
            profile = None
    return bool(profile and profile.get("email_verified_at"))


def mark_email_verified(user_id: str, now: datetime | None = None) -> None:
    """Mark the email verified and delete existing refresh tokens for this account."""
    from backend.users.store import read_profile, write_profile

    profile = read_profile(user_id)
    if not profile or profile.get("email_verified_at"):
        return
    verified_at = (now or datetime.now(timezone.utc)).isoformat()
    if connection.enabled():
        db_accounts.verify_email_and_revoke_sessions(user_id, verified_at)
        return
    profile["email_verified_at"] = verified_at
    write_profile(user_id, profile)
    for token_path in (config.AUTH_DIR / "refresh").glob("*.json"):
        try:
            with open(token_path, encoding="utf-8") as token_file:
                refresh = json.load(token_file)
        except (OSError, ValueError):
            continue
        if refresh.get("user_id") == user_id:
            token_path.unlink(missing_ok=True)
