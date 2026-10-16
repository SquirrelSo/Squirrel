"""Publishes finished workouts to the Social service, so they show on the member's profile and can be
shared as posts: POST {SOCIAL_API_URL}/internal/v1/activities with the service token
SOCIAL_INTERNAL_TOKEN (social-backend/app/routers/internal.py).

Called after a session's database row is written (db/exercise_sessions.sync_session), which happens
after every set; the Social service keeps one activity per session and updates its summary each time.
Fire-and-forget on a daemon thread: the long timeout lets a sleeping free-plan service wake up, and a
failure is logged, never raised, so publishing can never slow down or break training. Without both
settings it does nothing.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import urllib.error
import urllib.request

log = logging.getLogger(__name__)

TIMEOUT_S = 90
_NAMES = {"squat": "Squats", "pushup": "Push-ups", "bicep_curl": "Bicep curls", "high_knee": "High knees"}
_MAX_METRICS = 20


def configured() -> tuple[str, str] | None:
    url = os.environ.get("SOCIAL_API_URL", "").strip().rstrip("/")
    token = os.environ.get("SOCIAL_INTERNAL_TOKEN", "").strip()
    return (url, token) if url and token else None


def activity_payload(activity_row: dict) -> dict:
    """The Social service's InternalActivityIn for one activity_sessions row."""
    metrics = {
        key: value
        for key, value in (activity_row.get("metrics") or {}).items()
        if isinstance(value, (int, float, str, bool)) and not (isinstance(value, str) and len(value) > 60)
    }
    subtype = activity_row["subtype"]
    metrics["exercise"] = subtype
    started = activity_row["started_at"]
    return {
        "user_subject": activity_row["user_id"],
        "type": "workout",
        "source": "exercise",
        "source_ref": activity_row["metrics"]["session_id"],
        "started_at": started.isoformat() if hasattr(started, "isoformat") else str(started),
        "name": _NAMES.get(subtype, subtype.replace("_", " ").capitalize()),
        "duration_s": activity_row.get("duration_s"),
        "calories": activity_row.get("calories_kcal"),
        "metrics": dict(list(metrics.items())[:_MAX_METRICS]),
    }


def publish(activity_row: dict | None) -> threading.Thread | None:
    """Send one workout in the background. Returns the thread (tests join it), or None when there is
    nothing to send or publishing is not configured."""
    target = configured()
    if activity_row is None or target is None:
        return None
    thread = threading.Thread(target=_send, args=(*target, activity_payload(activity_row)), daemon=True)
    thread.start()
    return thread


def _send(url: str, token: str, payload: dict) -> None:
    request = urllib.request.Request(
        f"{url}/internal/v1/activities",
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        log.warning("Social rejected workout %s: HTTP %s %s", payload["source_ref"], exc.code, exc.read()[:200])
    except Exception as exc:  # noqa: BLE001 — never let publishing break anything
        log.warning("could not publish workout %s to Social: %s", payload["source_ref"], exc)
