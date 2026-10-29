"""Partner Hunt policy — every threshold and vocabulary the feature decides on, in one place.

Nothing here is tuned from data yet; these are product decisions. They live together so a change to
who can use Partner Hunt, or how matches rank, is a one-file review rather than a hunt through code.
"""

from __future__ import annotations

# --- access ------------------------------------------------------------------------------------
# The XP a user needs before Partner Hunt opens to them, passed to the Run Module's
# meetsXPGate(userId, minXP). The Run Module does not store this: per the integration contract the
# caller supplies it, so this constant IS the product decision. Agreed at 100.
PARTNER_HUNT_MIN_XP = 100

# Partner Hunt introduces people to strangers they may meet in person. Nobody under this age uses it,
# and nobody whose age cannot be established (no or unreadable date of birth) does either — an
# unverifiable age is treated as failing the check, never as passing it.
MIN_AGE = 18
MAX_PARTNER_AGE = 99

# --- vocabularies ------------------------------------------------------------------------------
# Broad activities people look for company in. Deliberately not the app's individual exercises: nobody
# hunts for a "bicep curl partner", they hunt for someone to go to the gym or run with.
ACTIVITIES = (
    "running",
    "walking",
    "cycling",
    "strength_training",
    "home_workout",
    "yoga",
    "hiit",
    "sports",
)

WORKOUT_TIMES = ("early_morning", "morning", "afternoon", "evening", "night")

# in_person needs a shared city; remote does not; either accepts both.
MODES = ("in_person", "remote", "either")

# Gender values a partner preference may name. They mirror the onboarding form's options. A profile
# that says "undisclosed" (or anything unrecognised) never satisfies a preference that names specific
# genders, because the preference cannot be confirmed — it only matches users who set no preference.
PARTNER_GENDERS = ("female", "male", "non_binary")

# What the app shows for each key (GET /api/users/{id}/partner-hunt → options), so the app never keeps
# its own copy of these vocabularies. Every key above has exactly one label (tests check it).
ACTIVITY_LABELS = {
    "running": "Running",
    "walking": "Walking",
    "cycling": "Cycling",
    "strength_training": "Strength training",
    "home_workout": "Home workout",
    "yoga": "Yoga",
    "hiit": "HIIT",
    "sports": "Sports",
}
WORKOUT_TIME_LABELS = {
    "early_morning": "Early morning",
    "morning": "Morning",
    "afternoon": "Afternoon",
    "evening": "Evening",
    "night": "Night",
}
MODE_LABELS = {"in_person": "In person", "remote": "Remote", "either": "Either"}
PARTNER_GENDER_LABELS = {"female": "Female", "male": "Male", "non_binary": "Non-binary"}

# The existing skill levels (users/skill.json), in order, so "one level apart" is computable.
FITNESS_LEVELS = ("beginner", "intermediate", "advanced")

# --- ranking -----------------------------------------------------------------------------------
# Weights sum to 100 so a score reads as a percentage. Activities dominate because a partner who does
# not do what you do is not a partner; schedule next because two people who never train at the same
# time cannot train together.
WEIGHT_ACTIVITIES = 40
WEIGHT_TIMES = 25
WEIGHT_LEVEL = 20
WEIGHT_MODE = 15

MAX_MATCHES = 50

# Age bands shown on a card. A match sees a band, never a birth date or an exact age.
AGE_BANDS = ((18, 24), (25, 34), (35, 44), (45, 54), (55, MAX_PARTNER_AGE))

# --- connecting ----------------------------------------------------------------------------------
# A request (Connect) lasts this long unanswered. A decline is silent: the sender sees the request
# as pending until it expires, exactly as if it had gone unanswered.
REQUEST_TTL_DAYS = 14
# One request per person per this long, however the last one ended (unanswered, declined, withdrawn),
# so a silent decline can't be worked around by asking again.
REQUEST_COOLDOWN_DAYS = 30
MAX_NEW_REQUESTS_PER_DAY = 10
MAX_PENDING_OUTGOING = 20
