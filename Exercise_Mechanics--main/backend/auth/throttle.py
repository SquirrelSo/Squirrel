"""Limits on sign-in, sign-up and token refresh, so nobody can guess passwords or mass-create accounts.

    failed logins for one email     5 per 15 minutes    (then that email is locked for the rest of the window)
    failed logins from one address  50 per 15 minutes
    sign-ups from one address       20 per hour
    refreshes from one address      1000 per 15 minutes
    sign-up codes to one email      5 per hour
    sign-up codes from one address  30 per hour

The per-account limit is the real protection against password guessing. The per-address limits are
loose on purpose: mobile carriers put many phones behind one public address (CGNAT), so a tight one
would lock out real people; they only stop one machine hammering the service.

A request over a limit gets 429 with Retry-After, before any password is checked, so a locked-out guesser
learns nothing. A successful login clears that email's failures. Emails are counted by their SHA-256, never
stored in plain text.

With DATABASE_URL set the counters are rows of `auth_throttle` (migration 003), shared by every app
instance; without it, they live in this process.
"""

from __future__ import annotations

import hashlib
import math
import threading
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request, status

from backend.db import connection


@dataclass(frozen=True)
class Limit:
    name: str
    max_hits: int
    window_s: int


LOGIN_EMAIL = Limit("login-email", 5, 15 * 60)
LOGIN_IP = Limit("login-ip", 50, 15 * 60)
SIGNUP_IP = Limit("signup-ip", 20, 60 * 60)
ACCESS_CODE_SIGNUP_IP = Limit("access-code-signup-ip", 5, 15 * 60)
ACCESS_CODE_SIGNUP_GLOBAL = Limit("access-code-signup-global", 100, 60 * 60)
REFRESH_IP = Limit("refresh-ip", 1000, 15 * 60)
EMAIL_CODE_EMAIL = Limit("email-code-email", 5, 60 * 60)
EMAIL_CODE_IP = Limit("email-code-ip", 30, 60 * 60)

_memory: dict[str, tuple[float, int]] = {}
_memory_lock = threading.Lock()


class Throttled(Exception):
    def __init__(self, retry_after_s: int):
        super().__init__(retry_after_s)
        self.retry_after_s = retry_after_s


def email_key(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()


def client_address(request: Request) -> str:
    # uvicorn runs with --proxy-headers, so behind a proxy this is already the caller's address.
    return request.client.host if request.client else "unknown"


def _key(limit: Limit, who: str) -> str:
    return f"{limit.name}:{who}"[:200]


def _retry_after(window_start: float, limit: Limit, now: float) -> int:
    return max(1, math.ceil(window_start + limit.window_s - now))


def check(limit: Limit, who: str, *, now: float | None = None) -> None:
    """Raise Throttled when `who` has used up `limit`. Counts nothing."""
    now = time.time() if now is None else now
    key = _key(limit, who)
    if connection.enabled():
        with connection.pooled() as conn:
            row = conn.execute("SELECT extract(epoch FROM window_start), hits FROM auth_throttle WHERE key = %s",
                               (key,)).fetchone()
        start, hits = (float(row[0]), row[1]) if row else (now, 0)
    else:
        with _memory_lock:
            start, hits = _memory.get(key, (now, 0))
    if now - start < limit.window_s and hits >= limit.max_hits:
        raise Throttled(_retry_after(start, limit, now))


def hit(limit: Limit, who: str, *, now: float | None = None) -> None:
    """Count one use (a fresh window starts once the old one has passed)."""
    now = time.time() if now is None else now
    key = _key(limit, who)
    if connection.enabled():
        with connection.pooled() as conn:
            conn.execute(
                "INSERT INTO auth_throttle AS t (key, window_start, hits) VALUES (%(k)s, to_timestamp(%(now)s), 1) "
                "ON CONFLICT (key) DO UPDATE SET "
                "  hits = CASE WHEN t.window_start <= to_timestamp(%(now)s) - make_interval(secs => %(w)s) "
                "              THEN 1 ELSE t.hits + 1 END, "
                "  window_start = CASE WHEN t.window_start <= to_timestamp(%(now)s) - make_interval(secs => %(w)s) "
                "              THEN to_timestamp(%(now)s) ELSE t.window_start END",
                {"k": key, "now": now, "w": limit.window_s})
        return
    with _memory_lock:
        start, hits = _memory.get(key, (now, 0))
        _memory[key] = (now, 1) if now - start >= limit.window_s else (start, hits + 1)


def clear(limit: Limit, who: str) -> None:
    key = _key(limit, who)
    if connection.enabled():
        with connection.pooled() as conn:
            conn.execute("DELETE FROM auth_throttle WHERE key = %s", (key,))
        return
    with _memory_lock:
        _memory.pop(key, None)


def reset_memory() -> None:
    """Tests only."""
    with _memory_lock:
        _memory.clear()


def too_many(exc: Throttled) -> HTTPException:
    minutes = max(1, math.ceil(exc.retry_after_s / 60))
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=f"Too many attempts. Try again in {minutes} minute{'s' if minutes != 1 else ''}.",
        headers={"Retry-After": str(exc.retry_after_s)},
    )
