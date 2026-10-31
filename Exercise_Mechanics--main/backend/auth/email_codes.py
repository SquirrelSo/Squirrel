"""Sign-up email verification: a 6-digit code sent to the address, required to create the account.

    POST /api/auth/email-code {email}   → the address's domain is checked, a code is emailed
    POST /api/auth/register {…, code}   → the code is checked (and used up) before the account exists

So every account made while verification is on (config.email_verification_required) has proved it
owns its address; its access tokens carry `"ev": true` (auth/tokens.py), which the Social service
reads for the founding-member badges.

    a code lives           10 minutes
    wrong guesses          5, then the code is dead and a new one must be requested
    a new code             at most one every 30 seconds per address,
                           5 an hour per address, 30 an hour per caller address (auth/throttle.py)

Storage mirrors the rest of auth: the email_verification_codes table with DATABASE_URL (migration
004), else files under config.AUTH_DIR/email_codes. Emails are keyed by their SHA-256; codes are
kept only as an HMAC with the signing secret.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

from backend import config, mailer
from backend.auth import throttle
from backend.auth.store import normalize_email, normalize_signup_email
from backend.auth.tokens import signing_secret
from backend.db import connection

CODE_TTL_S = 10 * 60
MAX_ATTEMPTS = 5
RESEND_AFTER_S = 30


class DomainNotAllowed(Exception):
    pass


class ResendTooSoon(Exception):
    def __init__(self, retry_after_s: int):
        super().__init__(retry_after_s)
        self.retry_after_s = retry_after_s


class CodeInvalid(Exception):
    """Wrong, expired, used up or never sent: the caller is told only that the code did not work."""


@dataclass
class _Record:
    code_hmac: str
    sent_at: float
    expires_at: float
    attempts: int


def domain_allowed(email: str) -> bool:
    domains = config.allowed_email_domains()
    if domains is None:
        return True
    _, _, domain = normalize_email(email).rpartition("@")
    return any(domain == d or domain.endswith("." + d) for d in domains)


def check_domain(email: str) -> None:
    if not domain_allowed(email):
        raise DomainNotAllowed(email)


def allowed_domains_text() -> str:
    """For the refusal message: "college (.ac.in)" for the default, else "@a.b or @c.d"."""
    domains = config.allowed_email_domains() or ()
    if domains == ("ac.in",):
        return "college (.ac.in)"
    return " or ".join(f"@{d}" for d in domains)


def _email_sha(email: str) -> str:
    return hashlib.sha256(normalize_signup_email(email).encode()).hexdigest()


def _code_hmac(email: str, code: str) -> str:
    return hmac.new(signing_secret(), f"{normalize_signup_email(email)}:{code}".encode(), hashlib.sha256).hexdigest()


def _path(email: str) -> Path:
    return config.AUTH_DIR / "email_codes" / f"{_email_sha(email)}.json"


# ---------------------------------------------------------------- storage

def _read(email: str) -> _Record | None:
    if connection.enabled():
        with connection.pooled() as conn:
            row = conn.execute(
                "SELECT code_hmac, extract(epoch FROM sent_at), extract(epoch FROM expires_at), attempts "
                "FROM email_verification_codes WHERE email_sha256 = %s", (_email_sha(email),)).fetchone()
        return _Record(row[0], float(row[1]), float(row[2]), row[3]) if row else None
    try:
        with open(_path(email)) as f:
            raw = json.load(f)
    except (FileNotFoundError, ValueError):
        return None
    return _Record(raw["code_hmac"], raw["sent_at"], raw["expires_at"], raw["attempts"])


def _write(email: str, record: _Record) -> None:
    if connection.enabled():
        with connection.pooled() as conn:
            conn.execute(
                "INSERT INTO email_verification_codes (email_sha256, code_hmac, sent_at, expires_at, attempts) "
                "VALUES (%s, %s, to_timestamp(%s), to_timestamp(%s), %s) ON CONFLICT (email_sha256) DO UPDATE SET "
                "code_hmac = EXCLUDED.code_hmac, sent_at = EXCLUDED.sent_at, expires_at = EXCLUDED.expires_at, "
                "attempts = EXCLUDED.attempts",
                (_email_sha(email), record.code_hmac, record.sent_at, record.expires_at, record.attempts))
        return
    path = _path(email)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    with open(temp, "w") as f:
        json.dump(record.__dict__, f)
    os.replace(temp, path)


def _count_attempt(email: str) -> int:
    """Count one guess against the live code; returns the attempts used so far (atomic in SQL)."""
    if connection.enabled():
        with connection.pooled() as conn:
            row = conn.execute("UPDATE email_verification_codes SET attempts = attempts + 1 "
                               "WHERE email_sha256 = %s RETURNING attempts", (_email_sha(email),)).fetchone()
        return row[0] if row else MAX_ATTEMPTS + 1
    record = _read(email)
    if record is None:
        return MAX_ATTEMPTS + 1
    record.attempts += 1
    _write(email, record)
    return record.attempts


def _delete(email: str) -> None:
    if connection.enabled():
        with connection.pooled() as conn:
            conn.execute("DELETE FROM email_verification_codes WHERE email_sha256 = %s", (_email_sha(email),))
        return
    _path(email).unlink(missing_ok=True)


# ---------------------------------------------------------------- the flow

def send_code(email: str, caller: str, *, now: float | None = None, any_domain: bool = False) -> int:
    """Email a fresh code to `email`. Returns its lifetime in seconds. `any_domain` skips the
    allow-list (a sign-in code for an account that already exists).

    Raises DomainNotAllowed, ResendTooSoon, throttle.Throttled or mailer.EmailNotSent."""
    now = time.time() if now is None else now
    if not any_domain:
        check_domain(email)
    previous = _read(email)
    if previous is not None and now - previous.sent_at < RESEND_AFTER_S:
        raise ResendTooSoon(int(RESEND_AFTER_S - (now - previous.sent_at)) + 1)
    email_key = throttle.email_key(normalize_signup_email(email))
    throttle.check(throttle.EMAIL_CODE_EMAIL, email_key, now=now)
    throttle.check(throttle.EMAIL_CODE_IP, caller, now=now)
    throttle.hit(throttle.EMAIL_CODE_EMAIL, email_key, now=now)
    throttle.hit(throttle.EMAIL_CODE_IP, caller, now=now)

    code = f"{secrets.randbelow(1_000_000):06d}"
    _write(email, _Record(_code_hmac(email, code), now, now + CODE_TTL_S, 0))
    try:
        mailer.send_email(
            normalize_email(email),
            f"{code} is your Squirrel Social code",
            f"Your Squirrel Social code is {code}.\n\n"
            f"It works for {CODE_TTL_S // 60} minutes. If you didn't ask for it, ignore this email.\n",
        )
    except mailer.EmailNotSent:
        _delete(email)  # nothing was sent: let the person try again straight away
        raise
    return CODE_TTL_S


def consume_code(email: str, code: str, *, now: float | None = None) -> None:
    """Check `code` for `email` and use it up. Raises CodeInvalid."""
    now = time.time() if now is None else now
    record = _read(email)
    if record is None or record.expires_at <= now:
        raise CodeInvalid
    attempts = _count_attempt(email)
    if attempts > MAX_ATTEMPTS:
        _delete(email)
        raise CodeInvalid
    if not hmac.compare_digest(record.code_hmac, _code_hmac(email, code.strip())):
        if attempts >= MAX_ATTEMPTS:
            _delete(email)
        raise CodeInvalid
    _delete(email)
