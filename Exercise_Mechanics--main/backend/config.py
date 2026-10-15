"""Application configuration — visibility floors, per-user storage paths, Squirrel Social settings."""

import os
from pathlib import Path

# --- landmark visibility floors (single source of truth for BOTH tiers) ------
#   VISIBILITY_MIN — base "in frame" floor (skeleton draw, non-critical gating).
#   CONFIDENCE_MIN — stricter "safe to compute on" floor (the joints a rule computes on).
VISIBILITY_MIN = 0.3
CONFIDENCE_MIN = 0.5

# --- per-user storage --------------------------------------------------------
# One directory per user (slug + short hash) under USERS_DIR, holding the user's profile.json,
# skill.json, and their sessions. Lives at the REPO ROOT (<root>/data/users), OUTSIDE the
# backend package — decoupling data from code so a backend rewrite never touches user data.
# config.py is at backend/config.py, so parent.parent is the repo root.
_REPO_ROOT       = Path(__file__).resolve().parent.parent
USERS_DIR        = _REPO_ROOT / "data" / "users"
PROFILE_FILENAME = "profile.json"
SKILL_FILENAME   = "skill.json"   # the user's chosen skill level (set on the dashboard)

# Moderation reports are not any one user's data, so they live apart from the user directories.
REPORTS_DIR      = _REPO_ROOT / "data" / "moderation" / "reports"

# Shared workout sessions (Workout with Partner) without DATABASE_URL: one JSON file per session.
SHARED_WORKOUTS_DIR = _REPO_ROOT / "data" / "shared_workouts"
# Partner Hunt Connect requests without DATABASE_URL: one file for everyone's requests.
PARTNER_REQUESTS_FILE = _REPO_ROOT / "data" / "partner_hunt" / "requests.json"

def user_dir(user_id: str) -> Path:
    """Absolute path to a single user's directory under USERS_DIR."""
    return USERS_DIR / user_id

# --- Squirrel Social: auth, nearby discovery, deep links ----------------------
# Everything below is read through this module at call time (e.g. `config.AUTH_DIR`) so tests can
# monkeypatch a temp directory exactly as they do for USERS_DIR.
AUTH_DIR    = _REPO_ROOT / "data" / "auth"      # credentials index, refresh tokens, dev secret
INVITES_DIR = _REPO_ROOT / "data" / "invites"   # opaque invite tokens → inviter (no PII in token)

# HMAC key for access tokens (HS256 JWTs). Production MUST set SQUIRREL_AUTH_SECRET or JWT_SECRET;
# without either, a random development key is generated once and kept at AUTH_DIR/secret.key.
AUTH_SECRET_ENV            = "SQUIRREL_AUTH_SECRET"
# Fallback: the Run Module's secret. With both backends on one secret, one sign-in serves both.
SHARED_JWT_SECRET_ENV      = "JWT_SECRET"
# RS256 (ADR-003): with a private key set, tokens are signed with it and only RS256 is accepted; the
# Run Module and the Social service verify with the public key (JWT_SECRET = the public PEM and
# JWT_ALGORITHM = RS256 in the shared group). JWT_PRIVATE_KEY holds the PEM itself (escaped newlines
# allowed); JWT_PRIVATE_KEY_FILE names a file holding it (a Render secret file). Neither set: HS256.
JWT_PRIVATE_KEY_ENV        = "JWT_PRIVATE_KEY"
JWT_PRIVATE_KEY_FILE_ENV   = "JWT_PRIVATE_KEY_FILE"
ACCESS_TOKEN_TTL_SECONDS   = 15 * 60
REFRESH_TOKEN_TTL_SECONDS  = 30 * 24 * 3600

# Public link targets. The QR code and invite links always point at PUBLIC_BASE_URL/join so the
# same printed code works for Android, iOS, desktop and already-installed apps.
PUBLIC_BASE_URL  = os.environ.get("SQUIRREL_PUBLIC_BASE_URL", "https://squirrelsocial.app").rstrip("/")
APP_STORE_URL    = os.environ.get("SQUIRREL_APP_STORE_URL", "https://apps.apple.com/app/squirrel-social/id0000000000")
PLAY_STORE_URL   = os.environ.get("SQUIRREL_PLAY_STORE_URL", "https://play.google.com/store/apps/details?id=app.squirrelsocial")
APP_SCHEME       = "squirrelsocial"
# Universal Links (iOS) / App Links (Android) association. Comma-separated where plural.
IOS_APP_IDS              = [s for s in os.environ.get("SQUIRREL_IOS_APP_IDS", "").split(",") if s]
ANDROID_PACKAGE          = os.environ.get("SQUIRREL_ANDROID_PACKAGE", "app.squirrelsocial")
ANDROID_CERT_SHA256      = [s for s in os.environ.get("SQUIRREL_ANDROID_CERT_SHA256", "").split(",") if s]

# Every /api/users/{user_id}/... route and the training sockets require a bearer token for that
# user. On unless EXERCISE_REQUIRE_AUTH is 0/false/no/off: the switch exists only so the browser
# coach, which has no sign-in yet, can still be used on a development machine.
REQUIRE_AUTH_ENV = "EXERCISE_REQUIRE_AUTH"

def auth_required() -> bool:
   return os.environ.get(REQUIRE_AUTH_ENV, "").strip().lower() not in ("0", "false", "no", "off")

# Sign-up is open only to these email domains (SQUIRREL_ALLOWED_EMAIL_DOMAINS, comma-separated; a
# subdomain of one counts too). "*" allows any address. By default any Indian academic address
# (anything ending in .ac.in, e.g. iiserkol.ac.in, iitb.ac.in).
ALLOWED_EMAIL_DOMAINS_ENV = "SQUIRREL_ALLOWED_EMAIL_DOMAINS"
DEFAULT_ALLOWED_EMAIL_DOMAINS = "ac.in"

def allowed_email_domains() -> tuple[str, ...] | None:
   """The allowed domains, or None when any address may sign up."""
   raw = os.environ.get(ALLOWED_EMAIL_DOMAINS_ENV, DEFAULT_ALLOWED_EMAIL_DOMAINS)
   domains = tuple(d.strip().lower().lstrip("@") for d in raw.split(",") if d.strip())
   return None if not domains or "*" in domains else domains

# A new account needs the 6-digit code emailed to its address (auth/email_codes.py). On unless
# SQUIRREL_EMAIL_VERIFICATION is 0/false/no/off (local development and older tests).
EMAIL_VERIFICATION_ENV = "SQUIRREL_EMAIL_VERIFICATION"

def email_verification_required() -> bool:
   return os.environ.get(EMAIL_VERIFICATION_ENV, "").strip().lower() not in ("0", "false", "no", "off")