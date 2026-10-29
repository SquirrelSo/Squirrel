"""Settings, read once from the environment. See .env.example for every variable.

The service fails closed: without a JWT verification key (public key or JWKS URL) it refuses
to start, so a misconfigured deploy can never accept unauthenticated traffic.

Deployed next to the Exercise backend and the Run Module, it reads their shared settings when its
own SOCIAL_* ones are unset: JWT_SECRET / JWT_ALGORITHM (the HS256 tokens the Exercise backend
issues and the Run Module accepts), DATABASE_URL and CORS_ALLOWED_ORIGINS.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache

from app.services.zones import Zone, load_zones


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


def _opt(name: str) -> str | None:
    raw = os.environ.get(name, "").strip()
    return raw or None


def database_url_from_env() -> str:
    """SOCIAL_DATABASE_URL, else the shared DATABASE_URL, for SQLAlchemy's psycopg (v3) driver: a
    plain postgres:// or postgresql:// URL (as Supabase and the other services use) gets the
    driver added; query parameters such as sslmode/sslrootcert pass through to libpq."""
    url = _opt("SOCIAL_DATABASE_URL") or _opt("DATABASE_URL") or "sqlite:///./social.db"
    for plain in ("postgres://", "postgresql://"):
        if url.startswith(plain):
            return "postgresql+psycopg://" + url[len(plain):]
    return url


@dataclass(frozen=True)
class Settings:
    database_url: str = "sqlite:///./social.db"

    # --- auth: the same RS256 bearer tokens the Run Module accepts ---------------------
    jwt_public_key: str | None = None      # PEM (SOCIAL_JWT_PUBLIC_KEY or SOCIAL_JWT_PUBLIC_KEY_FILE)
    jwks_url: str | None = None            # or a JWKS endpoint of the account service
    jwt_algorithms: tuple[str, ...] = ("RS256",)
    jwt_issuer: str | None = None
    jwt_audience: str | None = None

    # --- upstream services ---------------------------------------------------------------
    # Run Module base URL. XP and run stats are read from it with the caller's own token.
    run_module_url: str | None = None
    run_module_timeout_s: float = 4.0
    # Shared secret for service-to-service activity ingestion (POST /internal/v1/activities).
    internal_token: str | None = None
    # Other people's XP is a read cache of the Run Module's total, refreshed in one batch call when
    # older than this (ADR-032 "XP reads").
    xp_cache_ttl_s: int = 300

    # --- progression (mirrors the app: 2,000 XP per level) -------------------------------
    xp_per_level: int = 2000
    streak_timezone: str = "Asia/Kolkata"

    # --- media (S3-compatible). Unset bucket = uploads disabled (503). -----------------
    media_bucket: str | None = None
    media_region: str | None = None
    media_endpoint_url: str | None = None
    media_public_base_url: str | None = None
    media_max_bytes: int = 10 * 1024 * 1024

    # --- community ---------------------------------------------------------------------------
    # Hostels members pick from, for hostel vs hostel (SOCIAL_HOSTELS, comma-separated). Empty:
    # the hostel picker and the hostel board stay hidden.
    hostels: tuple[str, ...] = field(default_factory=tuple)
    # The app's public address, for invite links (SOCIAL_APP_URL), e.g. https://squirrel-social.vercel.app
    app_url: str | None = None
    # The first N email-verified members get "Founding Squirrel", the first M "Founding 500".
    founding_first: int = 15
    founding_total: int = 500
    # Verified friends who must join with your code to "skip the line".
    referrals_to_skip: int = 3
    # Local day and month for daily stats, boards and "km this month" (the campus's time zone).
    community_timezone: str = "Asia/Kolkata"
    # Named campus zones for Squirrel Dates (SOCIAL_ZONES_FILE or SOCIAL_ZONES; services/zones.py).
    # Empty: Squirrel Dates says the campus zones aren't set up yet.
    zones: tuple[Zone, ...] = field(default_factory=tuple)
    # Activity badges (services/badges.py), in community time. Early Bird: this many verified
    # activities started from early_bird_from_hour:00 to before early_bird_hour:00; Night Owl: from
    # night_owl_hour:00 to before early_bird_from_hour:00 (a 1 AM run is a late night, not an early
    # start); Park Regular: the same named zone on park_regular_days different days.
    early_bird_from_hour: int = 4
    early_bird_hour: int = 7
    early_bird_activities: int = 5
    night_owl_hour: int = 21
    night_owl_activities: int = 5
    park_regular_days: int = 5

    # --- notifications ------------------------------------------------------------------
    push_enabled: bool = True                # send Expo pushes (SOCIAL_PUSH=off to only store them)
    expo_access_token: str | None = None     # EXPO_ACCESS_TOKEN, when the Expo project requires one
    reminders_enabled: bool = True           # the in-process event-reminder loop
    push_receipts_enabled: bool = True       # the in-process Expo receipt check (services/push.py)
    event_reminder_minutes: int = 60

    # --- ambassador ----------------------------------------------------------------------
    ambassador_open: bool = False
    ambassador_reapply_days: int = 30

    # --- misc ----------------------------------------------------------------------------
    cors_origins: tuple[str, ...] = field(default_factory=tuple)
    rate_limits_enabled: bool = True


@lru_cache
def get_settings() -> Settings:
    key = _opt("SOCIAL_JWT_PUBLIC_KEY")
    key_file = _opt("SOCIAL_JWT_PUBLIC_KEY_FILE")
    if not key and key_file:
        with open(key_file) as f:
            key = f.read()
    algorithms = os.environ.get("SOCIAL_JWT_ALGORITHMS", "RS256")
    if not key and not _opt("SOCIAL_JWKS_URL") and _opt("JWT_SECRET"):
        # The shared HS256 secret the Exercise backend signs with (never an RS256 public key).
        key = _opt("JWT_SECRET")
        algorithms = _opt("SOCIAL_JWT_ALGORITHMS") or _opt("JWT_ALGORITHM") or "HS256"
    return Settings(
        database_url=database_url_from_env(),
        jwt_public_key=key.replace("\\n", "\n") if key else None,
        jwks_url=_opt("SOCIAL_JWKS_URL"),
        jwt_algorithms=tuple(a.strip() for a in algorithms.split(",") if a.strip()),
        jwt_issuer=_opt("SOCIAL_JWT_ISSUER"),
        jwt_audience=_opt("SOCIAL_JWT_AUDIENCE"),
        run_module_url=(_opt("SOCIAL_RUN_MODULE_URL") or _opt("RUN_MODULE_URL") or _opt("RUN_API_URL") or "").rstrip("/") or None,
        run_module_timeout_s=float(os.environ.get("SOCIAL_RUN_MODULE_TIMEOUT_S", "4")),
        internal_token=_opt("SOCIAL_INTERNAL_TOKEN"),
        xp_cache_ttl_s=_int("SOCIAL_XP_CACHE_TTL_S", 300),
        xp_per_level=_int("SOCIAL_XP_PER_LEVEL", 2000),
        streak_timezone=os.environ.get("SOCIAL_STREAK_TIMEZONE", "Asia/Kolkata"),
        media_bucket=_opt("SOCIAL_MEDIA_BUCKET"),
        media_region=_opt("SOCIAL_MEDIA_REGION"),
        media_endpoint_url=_opt("SOCIAL_MEDIA_ENDPOINT_URL"),
        media_public_base_url=(_opt("SOCIAL_MEDIA_PUBLIC_BASE_URL") or "").rstrip("/") or None,
        media_max_bytes=_int("SOCIAL_MEDIA_MAX_BYTES", 10 * 1024 * 1024),
        cors_origins=tuple(
            o.strip()
            for o in (_opt("SOCIAL_CORS_ORIGINS") or _opt("CORS_ALLOWED_ORIGINS") or "").split(",")
            if o.strip()
        ),
        rate_limits_enabled=os.environ.get("SOCIAL_RATE_LIMITS", "on").lower() not in ("off", "0", "false"),
        hostels=tuple(h.strip() for h in os.environ.get("SOCIAL_HOSTELS", "").split(",") if h.strip()),
        app_url=(_opt("SOCIAL_APP_URL") or "").rstrip("/") or None,
        founding_first=_int("SOCIAL_FOUNDING_FIRST", 15),
        founding_total=_int("SOCIAL_FOUNDING_TOTAL", 500),
        referrals_to_skip=_int("SOCIAL_REFERRALS_TO_SKIP", 3),
        community_timezone=os.environ.get("SOCIAL_COMMUNITY_TIMEZONE", "Asia/Kolkata"),
        zones=load_zones(os.environ.get("SOCIAL_ZONES"), _opt("SOCIAL_ZONES_FILE")),
        early_bird_from_hour=_int("SOCIAL_EARLY_BIRD_FROM_HOUR", 4),
        early_bird_hour=_int("SOCIAL_EARLY_BIRD_HOUR", 7),
        early_bird_activities=_int("SOCIAL_EARLY_BIRD_ACTIVITIES", 5),
        night_owl_hour=_int("SOCIAL_NIGHT_OWL_HOUR", 21),
        night_owl_activities=_int("SOCIAL_NIGHT_OWL_ACTIVITIES", 5),
        park_regular_days=_int("SOCIAL_PARK_REGULAR_DAYS", 5),
        push_enabled=os.environ.get("SOCIAL_PUSH", "on").lower() not in ("off", "0", "false"),
        expo_access_token=_opt("EXPO_ACCESS_TOKEN"),
        reminders_enabled=os.environ.get("SOCIAL_EVENT_REMINDERS", "on").lower() not in ("off", "0", "false"),
        push_receipts_enabled=os.environ.get("SOCIAL_PUSH_RECEIPTS", "on").lower() not in ("off", "0", "false"),
        event_reminder_minutes=_int("SOCIAL_EVENT_REMINDER_MINUTES", 60),
        # Opens only on an explicit yes: an empty or misspelled value keeps applications closed.
        ambassador_open=os.environ.get("SOCIAL_AMBASSADOR_OPEN", "off").strip().lower() in ("on", "1", "true", "yes"),
        ambassador_reapply_days=_int("SOCIAL_AMBASSADOR_REAPPLY_DAYS", 30),
    )
