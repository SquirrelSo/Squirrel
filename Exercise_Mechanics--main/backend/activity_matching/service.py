"""Activity-matching use cases: a member's status, their matches, and blocking."""

from __future__ import annotations

from datetime import date

from backend import card_ids, social_blocks
from backend.activity_matching import scoring
from backend.activity_matching.features import MatchingProfile, matching_profile
from backend.partners import store as partners_store
from backend.partners.matching import age_band, display_name
from backend.profiles.vocab import WORKOUT_TIMES
from backend.users.store import read_profile


class ActivityMatchingError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message}


def _member(user_id: str, today: date | None) -> MatchingProfile:
    member = matching_profile(user_id, today=today)
    if member is None:
        raise ActivityMatchingError(404, "user_not_found", "No such user.")
    return member


def status(user_id: str, *, today: date | None = None) -> dict:
    """What stands between the member and their matches, and exactly what others would see."""
    member = _member(user_id, today)
    missing = []
    if not scoring.is_adult(member):
        missing.append("age")
    if not member.consents_readable:
        missing.append("consents_unreadable")
    elif not member.opted_in:
        missing.append("matching_consent")
    if not member.interests:
        missing.append("activities")
    return {
        "opted_in": member.opted_in,
        "age_eligible": scoring.is_adult(member),
        "activities": [
            {"activity": code, "label": scoring.LABELS[code], "interest": interest}
            for code, interest in sorted(member.interests.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        "ready": not missing,
        "missing": missing,
        # Shown to the member so they can see what matching shares about them.
        "shared_with_matches": {
            "display_name": display_name(member.first_name, member.last_name),
            "age_band": age_band(member.age) if scoring.is_adult(member) else None,
            "fitness_level": member.fitness_level,
            "activities": [scoring.LABELS[c] for c in sorted(member.interests, key=scoring.CATALOGUE_ORDER.get)],
            "workout_times": sorted(member.workout_times, key=_time_order) if member.workout_times else None,
        },
    }


def find_matches(user_id: str, *, today: date | None = None) -> list[dict]:
    """Ranked suggestions. You only see others while others can see you (opted in, with activities)."""
    viewer = _member(user_id, today)
    if not scoring.is_adult(viewer):
        raise ActivityMatchingError(403, "age_restricted", "Activity matching is for members aged 18 and over.")
    if not viewer.consents_readable:
        raise ActivityMatchingError(503, "consents_unreadable",
                                    "Your consent settings can't be read right now, so matching is paused.")
    if not viewer.opted_in:
        raise ActivityMatchingError(403, "matching_consent_required",
                                    "Turn on activity matching to see members who share your activities.")
    if not viewer.interests:
        raise ActivityMatchingError(409, "activities_required",
                                    "Add at least one activity so we can find people who share it.")
    try:
        # Social owns blocks (ADR-032). The viewer's set holds both directions, so candidates need no
        # list of their own.
        viewer_blocks = social_blocks.blocked_either_way(user_id)
    except social_blocks.BlocksUnreachable as exc:
        raise _blocks_unreachable_error("so no matches were shown") from exc

    candidates: list[tuple[MatchingProfile, frozenset[str]]] = []
    for other_id in partners_store.list_user_ids():
        if other_id == user_id:
            continue
        other = matching_profile(other_id, today=today)
        if other is None or not other.opted_in:
            continue
        candidates.append((other, frozenset()))
    return [m.to_dict(user_id) for m in scoring.rank(viewer, candidates, viewer_blocks)]


def block(user_id: str, card_id: str) -> None:
    """Block the member on a card, by its card_id: a Social block (ADR-032), so it covers Partner
    Hunt and the rest of the app too."""
    if read_profile(user_id) is None:
        raise ActivityMatchingError(404, "user_not_found", "No such user.")
    blocked_user_id = card_ids.resolve(card_ids.ACTIVITY_MATCHING, user_id, card_id, partners_store.list_user_ids())
    if blocked_user_id is None or read_profile(blocked_user_id) is None:
        raise ActivityMatchingError(404, "user_not_found", "That member doesn't exist.")
    try:
        social_blocks.block(user_id, blocked_user_id)
    except social_blocks.BlocksUnreachable as exc:
        raise _blocks_unreachable_error("so nobody was blocked") from exc


def _blocks_unreachable_error(consequence: str) -> ActivityMatchingError:
    # Never "…_unavailable": the app reads a 503 code with that suffix as a feature not built yet.
    return ActivityMatchingError(503, "blocks_unreachable",
                                 f"Blocked members couldn't be checked right now, {consequence}. Try again in a moment.")


def _time_order(time: str) -> int:
    return WORKOUT_TIMES.index(time) if time in WORKOUT_TIMES else len(WORKOUT_TIMES)
