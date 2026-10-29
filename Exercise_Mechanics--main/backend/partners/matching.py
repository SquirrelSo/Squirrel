"""Partner Hunt matching: who may see whom, and in what order. Pure — no I/O, no clock.

Two stages, deliberately separate:

1. Eligibility — hard yes/no rules. Every rule that involves a preference is applied in BOTH
   directions: you see someone only if they fit what you asked for AND you fit what they asked for.
   A one-sided match would put people on boards of users they explicitly excluded.
2. Ranking — a 0–100 score with the reasons behind it, so a card can say why it is there.

The XP gate is an eligibility rule too, but the only one that costs a network call, so it is
consulted last and only for people who survived every other rule.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date

from backend.partners.policy import (
    AGE_BANDS,
    FITNESS_LEVELS,
    MAX_MATCHES,
    MIN_AGE,
    PARTNER_GENDERS,
    WEIGHT_ACTIVITIES,
    WEIGHT_LEVEL,
    WEIGHT_MODE,
    WEIGHT_TIMES,
)

UNDISCLOSED = "undisclosed"

ACTIVITY_LABELS = {
    "running": "running",
    "walking": "walking",
    "cycling": "cycling",
    "strength_training": "strength training",
    "home_workout": "home workouts",
    "yoga": "yoga",
    "hiit": "HIIT",
    "sports": "sports",
}

TIME_LABELS = {
    "early_morning": "early mornings",
    "morning": "mornings",
    "afternoon": "afternoons",
    "evening": "evenings",
    "night": "nights",
}


@dataclass(frozen=True)
class Preferences:
    visible: bool
    activities: frozenset[str]
    mode: str
    city: str | None
    preferred_times: frozenset[str]
    partner_genders: frozenset[str]  # empty means no preference
    partner_age_min: int
    partner_age_max: int

    @classmethod
    def from_dict(cls, data: dict) -> Preferences:
        return cls(
            visible=bool(data["visible"]),
            activities=frozenset(data["activities"]),
            mode=data["mode"],
            city=data.get("city"),
            preferred_times=frozenset(data["preferred_times"]),
            partner_genders=frozenset(data.get("partner_genders", ())),
            partner_age_min=int(data["partner_age_min"]),
            partner_age_max=int(data["partner_age_max"]),
        )


@dataclass(frozen=True)
class Person:
    user_id: str
    first_name: str
    last_name: str
    gender: str  # one of PARTNER_GENDERS, or UNDISCLOSED
    age: int | None
    fitness_level: str
    preferences: Preferences | None
    blocked_ids: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Match:
    user_id: str
    display_name: str
    age_band: str
    fitness_level: str
    shared_activities: tuple[str, ...]
    shared_times: tuple[str, ...]
    meet: tuple[str, ...]  # "in_person" and/or "remote"
    city: str | None       # only when meeting in person is on the table
    score: int
    reasons: tuple[str, ...]

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "display_name": self.display_name,
            "age_band": self.age_band,
            "fitness_level": self.fitness_level,
            "shared_activities": list(self.shared_activities),
            "shared_times": list(self.shared_times),
            "meet": list(self.meet),
            "city": self.city,
            "score": self.score,
            "reasons": list(self.reasons),
        }


# --- person helpers --------------------------------------------------------------------------------

def normalise_gender(raw: object) -> str:
    """Map a stored profile gender onto the preference vocabulary. Anything unrecognised becomes
    undisclosed, which no gender-restricted preference will accept."""
    return raw if isinstance(raw, str) and raw in PARTNER_GENDERS else UNDISCLOSED


def age_on(date_of_birth: object, today: date) -> int | None:
    """Whole years on `today`, or None when the birth date is missing, unreadable or in the future."""
    if not isinstance(date_of_birth, str):
        return None
    try:
        born = date.fromisoformat(date_of_birth)
    except ValueError:
        return None
    if born > today:
        return None
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


def age_band(age: int) -> str:
    for low, high in AGE_BANDS:
        if low <= age <= high:
            return f"{low}+" if high == AGE_BANDS[-1][1] else f"{low}–{high}"
    return f"{AGE_BANDS[-1][0]}+"


def display_name(first_name: str, last_name: str) -> str:
    """First name and last initial. A match never sees a full name before anything else exists."""
    first = first_name.strip() or "Member"
    initial = last_name.strip()[:1].upper()
    return f"{first} {initial}." if initial else first


# --- eligibility ------------------------------------------------------------------------------------

def is_age_eligible(person: Person) -> bool:
    return person.age is not None and person.age >= MIN_AGE


def exclusion_reason(viewer: Person, candidate: Person) -> str | None:
    """Why `candidate` must not appear on `viewer`'s board, or None when nothing rules them out.
    The XP gate is checked separately (see module docstring)."""
    if candidate.user_id == viewer.user_id:
        return "self"
    theirs = candidate.preferences
    mine = viewer.preferences
    if mine is None or theirs is None or not theirs.visible:
        return "not_visible"
    if not is_age_eligible(candidate):
        return "age"
    if candidate.user_id in viewer.blocked_ids or viewer.user_id in candidate.blocked_ids:
        return "blocked"
    if not _accepts(mine, candidate) or not _accepts(theirs, viewer):
        return "preferences"
    if not shared_modes(mine, theirs):
        return "mode"
    if not mine.activities & theirs.activities:
        return "activities"
    return None


def _accepts(preferences: Preferences, person: Person) -> bool:
    if preferences.partner_genders and person.gender not in preferences.partner_genders:
        return False
    if person.age is None:
        return False
    return preferences.partner_age_min <= person.age <= preferences.partner_age_max


def _expand(mode: str) -> frozenset[str]:
    return frozenset({"in_person", "remote"}) if mode == "either" else frozenset({mode})


def _same_city(a: Preferences, b: Preferences) -> bool:
    return bool(a.city and b.city and a.city.strip().casefold() == b.city.strip().casefold())


def shared_modes(a: Preferences, b: Preferences) -> frozenset[str]:
    """How two people could train together. Meeting in person needs them in the same city."""
    modes = _expand(a.mode) & _expand(b.mode)
    if "in_person" in modes and not _same_city(a, b):
        modes = modes - {"in_person"}
    return modes


# --- ranking ----------------------------------------------------------------------------------------

def score(viewer: Person, candidate: Person) -> Match:
    """Score an ELIGIBLE pair. Calling this on an excluded pair is a programming error."""
    mine, theirs = viewer.preferences, candidate.preferences
    assert mine is not None and theirs is not None and candidate.age is not None

    activities = mine.activities & theirs.activities
    times = mine.preferred_times & theirs.preferred_times
    modes = shared_modes(mine, theirs)
    level_gap = _level_gap(viewer.fitness_level, candidate.fitness_level)

    activity_part = WEIGHT_ACTIVITIES * len(activities) / len(mine.activities | theirs.activities)
    time_part = WEIGHT_TIMES * (len(times) / len(mine.preferred_times | theirs.preferred_times))
    level_part = WEIGHT_LEVEL * {0: 1.0, 1: 0.5}.get(level_gap, 0.0)
    # In person in the same city is the stronger match: it is what most people hunting for a
    # partner want. Remote still counts — it is a real way to train together — just for less.
    mode_part = WEIGHT_MODE * (1.0 if "in_person" in modes else 2 / 3)

    reasons: list[str] = [f"Both into {_join(ACTIVITY_LABELS[a] for a in _ordered(activities))}"]
    if times:
        reasons.append(f"Both train {_join(TIME_LABELS[t] for t in _ordered_times(times))}")
    else:
        reasons.append("Usually trains at different times")
    if level_gap == 0:
        reasons.append(f"Same level: {candidate.fitness_level}")
    elif level_gap == 1:
        reasons.append(f"Close in level: {candidate.fitness_level}")
    # Same city by definition (compared case- and space-insensitively), so the card uses the viewer's
    # OWN spelling: "Pune" to someone who typed Pune, whatever the other person typed.
    own_city = mine.city.strip() if mine.city else None
    if "in_person" in modes:
        reasons.append(f"Both in {own_city}, open to meeting up")
    else:
        reasons.append("Both open to training remotely")

    return Match(
        user_id=candidate.user_id,
        display_name=display_name(candidate.first_name, candidate.last_name),
        age_band=age_band(candidate.age),
        fitness_level=candidate.fitness_level,
        shared_activities=tuple(_ordered(activities)),
        shared_times=tuple(_ordered_times(times)),
        meet=tuple(m for m in ("in_person", "remote") if m in modes),
        city=own_city if "in_person" in modes else None,
        score=round(activity_part + time_part + level_part + mode_part),
        reasons=tuple(reasons),
    )


def rank(
    viewer: Person,
    people: Iterable[Person],
    passes_xp_gate: Callable[[str], bool],
    *,
    limit: int = MAX_MATCHES,
) -> list[Match]:
    """Everyone `viewer` may see, best first. `passes_xp_gate` is only called for people who cleared
    every other rule, since it is the one check that may go over the network."""
    matches = [
        score(viewer, person)
        for person in people
        if exclusion_reason(viewer, person) is None and passes_xp_gate(person.user_id)
    ]
    # Score first; user_id breaks ties so the board order is stable between refreshes.
    matches.sort(key=lambda m: (-m.score, m.user_id))
    return matches[:limit]


def _level_gap(a: str, b: str) -> int:
    try:
        return abs(FITNESS_LEVELS.index(a) - FITNESS_LEVELS.index(b))
    except ValueError:
        return len(FITNESS_LEVELS)


def _ordered(activities: Iterable[str]) -> list[str]:
    order = list(ACTIVITY_LABELS)
    return sorted(activities, key=order.index)


def _ordered_times(times: Iterable[str]) -> list[str]:
    order = list(TIME_LABELS)
    return sorted(times, key=order.index)


def _join(words: Iterable[str]) -> str:
    items = list(words)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]
