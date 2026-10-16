"""Nearby notification copy, anti-spam policy and delivery hook.

Copy never claims direction ("the person on your right") or identity — BLE RSSI cannot support
either — and acquisition copy only refers to Squirrel users actually detected, never to an
unidentified person.
"""

from __future__ import annotations

import logging
from typing import Protocol

from backend import config

log = logging.getLogger(__name__)

# A user is told about the same nearby person at most once per PAIR cooldown, and receives at most
# one nearby notification per USER cooldown, however many people come and go.
PAIR_NOTIFY_COOLDOWN_SECONDS = 6 * 3600
USER_NOTIFY_COOLDOWN_SECONDS = 20 * 60

NEARBY_DEEP_LINK = f"{config.APP_SCHEME}://nearby"

SINGLE_TITLE = "Someone near you is on Squirrel Social 👀"
SINGLE_BODY  = "You can connect with them. See who's nearby."
MULTI_TITLE  = "Someone nearby is on Squirrel Social 👀"
MULTI_BODY   = "There are Squirrel users around you. See who's nearby."
CTA          = "SEE WHO'S NEARBY"

# Acquisition (shown to people without the app: /join landing page, posters).
ACQUISITION_TITLE = "People around you are already on Squirrel Social 👀"
ACQUISITION_BODY  = "Join them and see who's around you."
ACQUISITION_CTA   = "JOIN SQUIRREL SOCIAL"
TAGLINE           = "Life unscrolled"


def nearby_copy(nearby_count: int) -> dict:
    if nearby_count >= 2:
        return {"title": MULTI_TITLE, "body": MULTI_BODY}
    return {"title": SINGLE_TITLE, "body": SINGLE_BODY}


class PushSender(Protocol):
    def send(self, user_id: str, notification: dict) -> None: ...


class LogPushSender:
    """Default: no remote push. Clients collect pending notifications via
    POST /api/notifications/nearby after each upload and show them locally. Swap in an
    APNs/FCM sender here when push credentials exist."""

    def send(self, user_id: str, notification: dict) -> None:
        log.debug("nearby notification queued (id=%s)", notification["id"])
