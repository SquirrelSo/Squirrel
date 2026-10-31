"""Pure activity-matching rules: who may be paired, how well, and why.

    activities  60%  the best shared activity, weighted by BOTH members' interest (5 × 5 = full
                     marks), plus a little for sharing more than one
    level       20%  same fitness level = full, one step apart = half, two apart = none
    schedule    20%  any overlap in preferred workout times; left out (weights rescaled) unless both
                     members share their times

Pairing needs at least one shared activity and is symmetric: A is suggested to B exactly when B is
suggested to A, and both see the same score.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend import card_ids
from backend.activity_matching.features import MatchingProfile
from backend.partners.matching import age_band, display_name
from backend.partners.policy import MIN_AGE
from backend.profiles.vocab import ACTIVITY_TYPES, FITNESS_LEVELS, WORKOUT_TIMES

WEIGHTS = {"activities": 0.60, "level": 0.20, "schedule": 0.20}
BEST_SHARED_SHARE = 0.8   # of the activities part; the rest rewards sharing 2–3 activities
MAX_MATCHES = 50
LABELS = {a.code: a.label for a in ACTIVITY_TYPES}
CATALOGUE_ORDER = {a.code: i for i, a in enumerate(ACTIVITY_TYPES)}
_TIME_WORDS = {"early_morning": "early morning", "morning": "morning", "afternoon": "afternoon",
               "evening": "evening", "night": "night"}


@dataclass(frozen=True)
class ActivityMatch:
    user_id: str
    display_name: str
    age_band: str
    fitness_level: str
    score: int
    shared_activities: tuple[str, ...]  # strongest shared interest first
    reasons: tuple[str, ...]

    def to_dict(self, viewer_id: str) -> dict:
        """The card as `viewer_id` sees it: named by an opaque card_id, never the account id (which
        spells the member's full name; see backend/card_ids.py)."""
        return {
            "card_id": card_ids.card_id(card_ids.ACTIVITY_MATCHING, viewer_id, self.user_id),
            "display_name": self.display_name,
            "age_band": self.age_band,
            "fitness_level": self.fitness_level,
            "score": self.score,
            "shared_activities": [{"activity": a, "label": LABELS[a]} for a in self.shared_activities],
            "reasons": list(self.reasons),
        }


def is_adult(person: MatchingProfile) -> bool:
    return person.age is not None and person.age >= MIN_AGE


def exclusion_reason(viewer: MatchingProfile, candidate: MatchingProfile,
                     viewer_blocks: frozenset[str], candidate_blocks: frozenset[str]) -> str | None:
    """Why the pair can't be matched, or None. Every rule applies to both sides."""
    if candidate.user_id == viewer.user_id:
        return "self"
    if not (viewer.opted_in and candidate.opted_in):
        return "not_opted_in"
    if not (is_adult(viewer) and is_adult(candidate)):
        return "age"
    if candidate.user_id in viewer_blocks or viewer.user_id in candidate_blocks:
        return "blocked"
    if not shared_activities(viewer, candidate):
        return "no_shared_activity"
    return None


def shared_activities(a: MatchingProfile, b: MatchingProfile) -> list[str]:
    """Shared activities, strongest joint interest first (ties in catalogue order)."""
    both = set(a.interests) & set(b.interests)
    return sorted(both, key=lambda code: (-(a.interests[code] * b.interests[code]), CATALOGUE_ORDER[code]))


def score(viewer: MatchingProfile, candidate: MatchingProfile) -> ActivityMatch:
    shared = shared_activities(viewer, candidate)
    best = shared[0]
    affinity = viewer.interests[best] * candidate.interests[best] / 25
    breadth = min(1.0, (len(shared) - 1) / 2)
    parts: dict[str, float | None] = {
        "activities": BEST_SHARED_SHARE * affinity + (1 - BEST_SHARED_SHARE) * breadth,
        "level": {0: 1.0, 1: 0.5}.get(_level_gap(viewer.fitness_level, candidate.fitness_level), 0.0),
        "schedule": None,
    }
    common_times: list[str] = []
    if viewer.workout_times and candidate.workout_times:
        common_times = [t for t in WORKOUT_TIMES if t in viewer.workout_times & candidate.workout_times]
        parts["schedule"] = 1.0 if common_times else 0.0

    present = {k: v for k, v in parts.items() if v is not None}
    total = sum(WEIGHTS[k] for k in present)
    value = round(100 * sum(WEIGHTS[k] * v for k, v in present.items()) / total)

    reasons = [f"You both do {_join([_in_sentence(LABELS[a]) for a in shared[:3]])}."]
    if viewer.interests[best] >= 4 and candidate.interests[best] >= 4:
        reasons.append(f"{LABELS[best]} is a favourite for both of you.")
    gap = _level_gap(viewer.fitness_level, candidate.fitness_level)
    if gap == 0:
        reasons.append(f"You're both {viewer.fitness_level}.")
    elif gap == 1:
        reasons.append("You're one fitness level apart.")
    if common_times:
        reasons.append(f"You both like to train in the {_join([_TIME_WORDS[t] for t in common_times])}.")

    return ActivityMatch(
        user_id=candidate.user_id,
        display_name=display_name(candidate.first_name, candidate.last_name),
        age_band=age_band(candidate.age) if candidate.age is not None else "",
        fitness_level=candidate.fitness_level,
        score=value,
        shared_activities=tuple(shared),
        reasons=tuple(reasons),
    )


def rank(viewer: MatchingProfile, candidates: list[tuple[MatchingProfile, frozenset[str]]],
         viewer_blocks: frozenset[str], *, limit: int = MAX_MATCHES) -> list[ActivityMatch]:
    """Eligible candidates, best first; ties broken by user id so the order is stable."""
    matches = [
        score(viewer, candidate)
        for candidate, candidate_blocks in candidates
        if exclusion_reason(viewer, candidate, viewer_blocks, candidate_blocks) is None
    ]
    matches.sort(key=lambda m: (-m.score, m.user_id))
    return matches[:limit]


def _level_gap(a: str, b: str) -> int:
    if a not in FITNESS_LEVELS or b not in FITNESS_LEVELS:
        return 2
    return abs(FITNESS_LEVELS.index(a) - FITNESS_LEVELS.index(b))


def _in_sentence(label: str) -> str:
    """'Running' -> 'running' mid-sentence, but acronyms like 'HIIT' stay as they are."""
    return label if label.isupper() else label.lower()


def _join(words: list[str]) -> str:
    if len(words) <= 1:
        return "".join(words)
    return f"{', '.join(words[:-1])} and {words[-1]}"
