"""Opaque invite tokens. The token itself encodes nothing; the inviter is looked up server-side.

    invites/<token>.json   {inviter, created_at, expires_at}
"""

from __future__ import annotations

import json
import re
import secrets
import time

from backend import config

INVITE_TTL_SECONDS = 30 * 24 * 3600
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


def is_valid_token(token: str) -> bool:
    return bool(_TOKEN_RE.fullmatch(token))


def create_invite(inviter: str, now: float | None = None) -> dict:
    now = now if now is not None else time.time()
    token = secrets.token_urlsafe(12)
    record = {"inviter": inviter, "created_at": int(now), "expires_at": int(now + INVITE_TTL_SECONDS)}
    config.INVITES_DIR.mkdir(parents=True, exist_ok=True)
    with open(config.INVITES_DIR / f"{token}.json", "w") as f:
        json.dump(record, f)
    return {"token": token, **record}


def read_invite(token: str, now: float | None = None) -> dict | None:
    """The invite record if the token is well-formed, known and unexpired; otherwise None."""
    if not is_valid_token(token):
        return None
    try:
        with open(config.INVITES_DIR / f"{token}.json") as f:
            record = json.load(f)
    except (OSError, ValueError):
        return None
    if record.get("expires_at", 0) <= (now if now is not None else time.time()):
        return None
    return record
