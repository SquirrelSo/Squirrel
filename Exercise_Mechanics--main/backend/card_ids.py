"""Opaque card ids: how an anonymous card (Partner Hunt, activity matching) names the person on it.

The Exercise account id spells out a member's full name ("priya-sharma-3f2a1c") and is their login
`sub`, so it never goes on a card: a card that says "Priya S." must not carry "priya-sharma" in the
same response. Instead each card carries

    card_id = HMAC(server key, scope · viewer · other), 22 url-safe characters

which is opaque, different for every viewer (two viewers can't compare notes on the same person),
different per feature (`scope`), and stable for one viewer across refreshes, so the app can key its
lists by it. Only the server can turn it back into a person, and only for that viewer: `resolve`
recomputes the id for each candidate and compares.

The key is derived from the signing secret (auth/tokens.signing_secret), so nothing new needs
configuring. Rotating that secret changes every card id; nothing stores them, so a card simply
reloads with a new one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from collections.abc import Iterable

from backend.auth import tokens

PARTNER_HUNT = "partner-hunt"
ACTIVITY_MATCHING = "activity-matching"

_CARD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")


def _key() -> bytes:
    return hmac.new(tokens.signing_secret(), b"squirrel-card-ids", hashlib.sha256).digest()


def card_id(scope: str, viewer: str, other: str) -> str:
    return _id(_key(), scope, viewer, other)


def _id(key: bytes, scope: str, viewer: str, other: str) -> str:
    digest = hmac.new(key, f"{scope}\0{viewer}\0{other}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest[:16]).decode().rstrip("=")


def is_card_id(raw: str | None) -> bool:
    return bool(raw and _CARD_ID_RE.fullmatch(raw))


def resolve(scope: str, viewer: str, raw: str | None, candidates: Iterable[str]) -> str | None:
    """The member among `candidates` whose card, as `viewer` sees it, has this id; None otherwise."""
    if not is_card_id(raw):
        return None
    key = _key()
    for other in candidates:
        if other != viewer and hmac.compare_digest(_id(key, scope, viewer, other), raw):
            return other
    return None
