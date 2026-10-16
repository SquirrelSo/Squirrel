"""The matching view: what activity matching may know about a member.

Coarse and consented only: first name and last initial, age (shown as a band), fitness level,
declared activities with their interest scores, and preferred workout times only when habits consent
is also granted. Never gender, body data, contact details or location.

Unreadable data fails closed: a member whose consent log can't be read counts as not opted in, so
nobody is shown on the strength of a consent that can't be confirmed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from backend.profiles import service as profiles
from backend.profiles import store as profile_store
from backend.profiles.store import HistoryUnreadable
from backend.profiles.vocab import ACTIVITY_CODES
from backend.users.store import read_profile, read_skill


@dataclass(frozen=True)
class MatchingProfile:
    user_id: str
    first_name: str
    last_name: str
    age: int | None
    fitness_level: str
    interests: dict[str, int]              # activity code -> interest 1..5
    workout_times: frozenset[str] | None   # None when not shared (no habits consent / not answered)
    opted_in: bool
    consents_readable: bool


def matching_profile(user_id: str, *, today: date | None = None) -> MatchingProfile | None:
    """The member's matching view, or None when there is no such member."""
    profile = read_profile(user_id)
    if profile is None:
        return None
    try:
        state = profiles.consent_state(profile_store.read_consent_events(user_id))
        consents_readable = True
    except HistoryUnreadable:
        state, consents_readable = {}, False
    granted = {c for c, event in state.items() if event and event["granted"]}

    born = profiles.parse_date_of_birth(profile.get("date_of_birth"))
    level, _ = read_skill(user_id)

    interests: dict[str, int] = {}
    for item in profile_store.read_section(user_id, "activities") or []:
        code, interest = item.get("activity"), item.get("interest")
        if code in ACTIVITY_CODES and isinstance(interest, int) and not isinstance(interest, bool):
            interests[code] = max(1, min(5, interest))

    times = None
    if "habits" in granted:
        habits = profile_store.read_section(user_id, "habits") or {}
        chosen = habits.get("preferred_workout_times")
        if isinstance(chosen, list) and chosen:
            times = frozenset(t for t in chosen if isinstance(t, str))

    return MatchingProfile(
        user_id=user_id,
        first_name=str(profile.get("first_name", "")),
        last_name=str(profile.get("last_name", "")),
        age=profiles.age_on(born, today or date.today()) if born else None,
        fitness_level=level,
        interests=interests,
        workout_times=times,
        opted_in="matching" in granted,
        consents_readable=consents_readable,
    )
