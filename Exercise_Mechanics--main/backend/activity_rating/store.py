"""Activity Rating persistence: one file beside the session it rates."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from backend import config
from backend.sessions.store import _atomic_write_json

log = logging.getLogger(__name__)

RATING_FILENAME = "activity_rating.json"
SCHEMA_VERSION = 1

RATING_MIN, RATING_MAX = 1, 5          # "How would you rate this session?"
EFFORT_MIN, EFFORT_MAX = 1, 10         # perceived exertion: 1 very easy … 10 maximal
FEELINGS = ("great", "good", "okay", "tired", "bad")
NOTE_MAX = 500


def _path(user_id: str, session_id: str):
    return config.user_dir(user_id) / "sessions" / session_id / RATING_FILENAME


def read_rating(user_id: str, session_id: str) -> dict | None:
    """The saved rating, or None when the session is unrated (a corrupt file reads as unrated)."""
    path = _path(user_id, session_id)
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
        rating = document["rating"]
    except (OSError, ValueError, KeyError, TypeError):
        log.warning("unreadable activity rating for %s/%s; treating as unrated", user_id, session_id)
        return None
    return rating if isinstance(rating, dict) else None


def write_rating(user_id: str, session_id: str, answers: dict, *, now: datetime | None = None) -> dict:
    """Create or replace the rating. `rated_at` keeps the first time it was rated."""
    moment = (now or datetime.now(timezone.utc)).isoformat()
    previous = read_rating(user_id, session_id)
    rating = {
        **answers,
        "rated_at": (previous or {}).get("rated_at") or moment,
        "updated_at": moment,
    }
    _atomic_write_json(_path(user_id, session_id), {"schema_version": SCHEMA_VERSION, "rating": rating})
    return rating


def delete_rating(user_id: str, session_id: str) -> bool:
    path = _path(user_id, session_id)
    existed = path.exists()
    path.unlink(missing_ok=True)
    return existed
