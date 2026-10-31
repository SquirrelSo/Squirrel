"""Notifications, sent through the Social service, which owns them (ADR-032):

    POST {SOCIAL_API_URL}/internal/v1/notifications
         { user_subject, kind, title, body, data, dedupe_key, actor_subject? }

Social puts the notification in the member's in-app list and sends the push. For a kind the caller
writes, Social fills `{actor}` in the title and body with the actor's display name, or with
`actor_fallback` when there is no actor or the two are blocked. Same service token and settings as
social_publish.py.

Fire-and-forget on a daemon thread, like social_publish: a notification that fails is logged and never
fails the action that caused it. `dedupe_key` makes a retry harmless on Social's side.
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.request
from collections.abc import Callable

from backend import social_publish

log = logging.getLogger(__name__)

NOTIFICATIONS_PATH = "/internal/v1/notifications"
TIMEOUT_S = 30

# Seams for tests: the HTTP opener, and how the send is run (a daemon thread).
_urlopen = urllib.request.urlopen


def _in_background(send: Callable[[], None]) -> None:
    threading.Thread(target=send, name="social-notify", daemon=True).start()


def notify(*, user_subject: str, kind: str, title: str, body: str | None, data: dict, dedupe_key: str,
           actor_subject: str | None = None) -> None:
    target = social_publish.configured()
    if target is None:
        log.warning("notification %s not sent: SOCIAL_API_URL and SOCIAL_INTERNAL_TOKEN are not set", kind)
        return
    url, token = target
    payload = {"user_subject": user_subject, "kind": kind, "title": title, "data": data, "dedupe_key": dedupe_key}
    if body is not None:
        payload["body"] = body
    if actor_subject is not None:
        payload["actor_subject"] = actor_subject

    def send() -> None:
        request = urllib.request.Request(
            url + NOTIFICATIONS_PATH, data=json.dumps(payload).encode(), method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with _urlopen(request, timeout=TIMEOUT_S) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            log.warning("Social refused notification %s: HTTP %s", kind, exc.code)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            log.warning("notification %s not sent, Social unreachable: %s", kind, exc)

    _in_background(send)
