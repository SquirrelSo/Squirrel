"""The person's own calendar.

Timestamps are stored in UTC. Every "which day / what time" a person sees (history, reports, the
activity calendar, streaks, "this week") follows the time zone of the phone that recorded the
session: an IANA name the app sends when it creates the session. Sessions without one (older ones,
clients that do not send it) use EXERCISE_DEFAULT_TIMEZONE, Asia/Kolkata unless set, the same
default as the Run Module's XP day (XP_TIMEZONE). Never UTC: a workout at 00:30 IST is 19:00 UTC
the day before.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_FALLBACK = "Asia/Kolkata"


def valid_zone(name: object) -> str | None:
    """The name if it is a known IANA time zone, else None."""
    if not isinstance(name, str) or not name.strip() or len(name) > 64 or name.startswith(("/", ".")):
        return None
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    return name


def default_zone() -> str:
    return valid_zone(os.environ.get("EXERCISE_DEFAULT_TIMEZONE", "").strip()) or _FALLBACK


def zone(name: object) -> tzinfo:
    """The session's zone, or the default."""
    return ZoneInfo(valid_zone(name) or default_zone())


def to_local(moment: datetime, name: object) -> datetime:
    """A moment on the person's clock (naive values are UTC)."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(zone(name))


def now_local(name: object) -> datetime:
    return datetime.now(timezone.utc).astimezone(zone(name))
