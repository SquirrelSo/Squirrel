"""Partner Hunt use cases: status, preferences, matches, blocking.

Access to the board, checked in this order, each with its own error code so the client can say
exactly what stands in the way:

    user_not_found        no profile
    age_restricted        under MIN_AGE, or age not established
    xp_unavailable        the Run Module's XP gate could not be consulted  (not the user's to fix)
    xp_locked             the gate says no: not enough XP yet             (the user's to fix)
    preferences_required  no preferences, or not visible — you browse only if others can see you
    blocks_unreachable    Social, which owns blocks, could not be asked     (not the user's to fix)
"""

from __future__ import annotations

import logging
from dataclasses import replace
from datetime import date, datetime, timezone

from backend import card_ids, social_blocks
from backend.partners import store
from backend.partners.matching import Person, Preferences, age_on, is_age_eligible, normalise_gender, rank
from backend.partners.policy import (
    ACTIVITIES,
    ACTIVITY_LABELS,
    MAX_PARTNER_AGE,
    MIN_AGE,
    MODE_LABELS,
    MODES,
    PARTNER_GENDER_LABELS,
    PARTNER_GENDERS,
    PARTNER_HUNT_MIN_XP,
    WORKOUT_TIME_LABELS,
    WORKOUT_TIMES,
)
from backend.partners.xp_gate import XPGate, XPServiceUnavailable
from backend.users.store import read_profile, read_skill

log = logging.getLogger(__name__)


class PartnerHuntError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: object) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message, **self.extra}


def partner_status(user_id: str, gate: XPGate, *, today: date | None = None) -> dict:
    """Everything the client needs to decide what to show, in one read. Never raises for a closed
    gate — being locked is a state to display, not an error."""
    person = _require_person(user_id, today)
    xp, unlocked = _xp_snapshot(user_id, gate)
    preferences = store.read_preferences(user_id)
    age_ok = is_age_eligible(person)
    return {
        "min_xp": PARTNER_HUNT_MIN_XP,
        "xp": xp,
        "unlocked": unlocked,
        "age_eligible": age_ok,
        "fitness_level": person.fitness_level,
        "preferences": preferences,
        "ready": bool(unlocked and age_ok and preferences and preferences.get("visible")),
        "options": options(),
    }


def options() -> dict:
    """Every vocabulary and limit the preferences form needs, in policy order, with English labels."""
    def labelled(keys: tuple[str, ...], labels: dict[str, str]) -> list[dict]:
        return [{"key": key, "label": labels[key]} for key in keys]

    return {
        "activities": labelled(ACTIVITIES, ACTIVITY_LABELS),
        "times": labelled(WORKOUT_TIMES, WORKOUT_TIME_LABELS),
        "modes": labelled(MODES, MODE_LABELS),
        "genders": labelled(PARTNER_GENDERS, PARTNER_GENDER_LABELS),
        "partner_age": {"min": MIN_AGE, "max": MAX_PARTNER_AGE},
        "min_xp": PARTNER_HUNT_MIN_XP,
    }


def save_preferences(user_id: str, preferences: dict, *, today: date | None = None) -> dict:
    """Preferences may be saved while still locked, so a user can set up in advance and appear on
    boards the moment they clear the gate."""
    person = _require_person(user_id, today)
    if not is_age_eligible(person):
        raise _age_error()
    return store.write_preferences(user_id, preferences)


def find_matches(user_id: str, gate: XPGate, *, today: date | None = None) -> list[dict]:
    """The board as the app sees it: cards named by card_id, never by account id."""
    return [public_card(user_id, match.to_dict()) for match in board(user_id, gate, today=today)]


def public_card(viewer_id: str, card: dict) -> dict:
    """A card for the app: the member's account id (it spells their full name, and is their login
    `sub`) is replaced by an opaque id only this viewer's requests can be resolved with."""
    card = dict(card)
    other = card.pop("user_id")
    return {"card_id": card_ids.card_id(card_ids.PARTNER_HUNT, viewer_id, other), **card}


def board(user_id: str, gate: XPGate, *, today: date | None = None) -> list:
    """Everyone `user_id` may see, as Match objects (with account ids: internal only)."""
    viewer = _require_person(user_id, today)
    if not is_age_eligible(viewer):
        raise _age_error()
    try:
        unlocked = gate.meets_xp_gate(user_id, PARTNER_HUNT_MIN_XP)
    except XPServiceUnavailable as exc:
        raise _xp_unavailable_error() from exc
    if not unlocked:
        xp, _ = _xp_snapshot(user_id, gate)
        raise PartnerHuntError(
            403, "xp_locked",
            f"Partner Hunt opens at {PARTNER_HUNT_MIN_XP} XP.",
            min_xp=PARTNER_HUNT_MIN_XP, xp=xp["xp"],
        )
    if viewer.preferences is None or not viewer.preferences.visible:
        raise PartnerHuntError(
            409, "preferences_required",
            "Set your Partner Hunt preferences and make yourself visible to browse. "
            "You can only see people who can see you.",
        )

    try:
        # Social's answer covers both directions (who the viewer blocked, and who blocked them), so it
        # is the only block list a board needs; candidates are not asked one by one.
        viewer = replace(viewer, blocked_ids=social_blocks.blocked_either_way(user_id))
    except social_blocks.BlocksUnreachable as exc:
        # Showing the board without the viewer's blocks would re-surface people they blocked.
        raise _blocks_unreachable_error("so the board is withheld") from exc

    people = []
    for candidate_id in store.list_user_ids():
        if candidate_id == user_id:
            continue
        candidate = _load_person(candidate_id, today)
        if candidate is not None:
            people.append(candidate)

    return rank(viewer, people, _cached_gate(gate))


def block_user(user_id: str, card_id: str) -> None:
    """Block the member on a card (the board, a request or a connection) by its card_id."""
    _require_person(user_id, None)
    blocked_user_id = card_ids.resolve(card_ids.PARTNER_HUNT, user_id, card_id, store.list_user_ids())
    if blocked_user_id is None or read_profile(blocked_user_id) is None:
        raise PartnerHuntError(404, "user_not_found", "That member doesn't exist.")
    try:
        # A real Social block, the same as the app's Block button: it hides the two people from each
        # other everywhere, not only in Partner Hunt.
        social_blocks.block(user_id, blocked_user_id)
    except social_blocks.BlocksUnreachable as exc:
        raise _blocks_unreachable_error("so nobody was blocked") from exc


# --- helpers ----------------------------------------------------------------------------------------

def _cached_gate(gate: XPGate):
    """One gate call per candidate per request, failing closed: a candidate whose XP cannot be
    confirmed is not shown."""
    answers: dict[str, bool] = {}

    def passes(candidate_id: str) -> bool:
        if candidate_id not in answers:
            try:
                answers[candidate_id] = gate.meets_xp_gate(candidate_id, PARTNER_HUNT_MIN_XP)
            except XPServiceUnavailable:
                answers[candidate_id] = False
        return answers[candidate_id]

    return passes


def _xp_snapshot(user_id: str, gate: XPGate) -> tuple[dict, bool]:
    try:
        status = gate.get_user_xp(user_id)
        unlocked = gate.meets_xp_gate(user_id, PARTNER_HUNT_MIN_XP)
    except XPServiceUnavailable:
        return {"available": False, "xp": None, "updated_at": None}, False
    return {"available": True, "xp": status.xp, "updated_at": status.updated_at}, unlocked


def _require_person(user_id: str, today: date | None) -> Person:
    person = _load_person(user_id, today)
    if person is None:
        raise PartnerHuntError(404, "user_not_found", "User not found.")
    return person


def _load_person(user_id: str, today: date | None) -> Person | None:
    profile = read_profile(user_id)
    if profile is None:
        return None
    raw_preferences = store.read_preferences(user_id)
    try:
        preferences = Preferences.from_dict(raw_preferences) if raw_preferences else None
    except (KeyError, TypeError, ValueError):
        log.warning("malformed Partner Hunt preferences for %s; treating as not set", user_id)
        preferences = None
    level, _ = read_skill(user_id)
    return Person(
        user_id=user_id,
        first_name=str(profile.get("first_name", "")),
        last_name=str(profile.get("last_name", "")),
        gender=normalise_gender(profile.get("gender")),
        age=age_on(profile.get("date_of_birth"), today or datetime.now(timezone.utc).date()),
        fitness_level=level,
        preferences=preferences,
    )


def _age_error() -> PartnerHuntError:
    return PartnerHuntError(
        403, "age_restricted",
        "Partner Hunt is for members aged 18 and over, with a date of birth on their profile.",
    )


def _blocks_unreachable_error(consequence: str) -> PartnerHuntError:
    # Never "…_unavailable": the app reads a 503 code with that suffix as a feature not built yet.
    return PartnerHuntError(
        503, "blocks_unreachable",
        f"Blocked members could not be checked right now, {consequence}. Try again in a moment.",
    )


def _xp_unavailable_error() -> PartnerHuntError:
    return PartnerHuntError(
        503, "xp_unavailable",
        "Your XP could not be checked right now. This is not something you need to fix — try again later.",
    )
