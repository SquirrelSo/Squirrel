"""Vocabularies, bounds and the activity catalogue for profile details.

Every enumerated answer is a closed tuple so the API can reject anything else, and every sensitive
question carries a "prefer not to say" option so answering it is never forced.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.users.store import SKILLS

GENDERS = ("female", "male", "non_binary", "other", "undisclosed")

# The app's "About you" form (GET/PUT /api/me/profile-details): the rules campus-service used before
# ADR-032 moved these details here (its migration 004) and the app's own checks. Its genders are ours
# without "other", which the form doesn't offer.
ABOUT_YOU_GENDERS = tuple(g for g in GENDERS if g != "other")
ABOUT_YOU_AGE = (16, 99)
CGPA = (0.0, 10.0)

# Same values as the dashboard skill level (skill.json), which stays the single source of truth.
FITNESS_LEVELS = SKILLS
ACTIVITY_LEVELS = ("sedentary", "light", "moderate", "active", "very_active")
PRIMARY_GOALS = ("lose_fat", "build_muscle", "endurance", "mobility", "general_health")

BODY_TYPES = ("slim", "average", "athletic", "muscular", "heavier", "prefer_not_to_say")

WORKOUT_TIMES = ("early_morning", "morning", "afternoon", "evening", "night")
DIETS = ("vegetarian", "vegan", "eggetarian", "non_vegetarian", "other", "prefer_not_to_say")
SMOKING = ("never", "former", "occasional", "regular", "prefer_not_to_say")
ALCOHOL = ("never", "occasional", "regular", "prefer_not_to_say")

EXPERIENCE = ("new", "some", "experienced")
INTEREST_MIN, INTEREST_MAX = 1, 5
MAX_DECLARED_ACTIVITIES = 20

# Consent-gated categories. Height and weight are core onboarding fields (the dashboard's BMI has
# always used them); body composition and body type are physique, and are gated. "matching" is the
# opt-in to activity matching: being suggested to other members, and seeing them.
CONSENT_CATEGORIES = ("physique", "habits", "matching")

MEASUREMENT_SOURCES = ("self_reported", "smart_scale", "wearable")

# Inclusive, human-plausible ranges. Anything outside is a typo, not a measurement.
HEIGHT_CM = (50.0, 272.0)
WEIGHT_KG = (20.0, 400.0)
BODY_FAT_PCT = (2.0, 70.0)
WAIST_CM = (30.0, 250.0)
WORKOUTS_PER_WEEK = (0, 14)
SLEEP_HOURS = (0.0, 16.0)

PHYSIQUE_MEASUREMENTS = ("body_fat_pct", "waist_cm")
CORE_MEASUREMENTS = ("height_cm", "weight_kg")
MEASUREMENT_FIELDS = CORE_MEASUREMENTS + PHYSIQUE_MEASUREMENTS


@dataclass(frozen=True)
class ActivityType:
    code: str
    label: str
    category: str   # cardio | strength | flexibility | sport
    tracked_by: str | None  # run_module | exercise_module | None (declared only)

    def to_dict(self) -> dict:
        return {"code": self.code, "label": self.label, "category": self.category, "tracked_by": self.tracked_by}


# Codes for camera-tracked exercises equal the workout catalog slugs, and "running" matches the
# Run Module, so a declared activity can later be compared with recorded sessions.
ACTIVITY_TYPES = (
    ActivityType("running", "Running", "cardio", "run_module"),
    ActivityType("walking", "Walking", "cardio", None),
    ActivityType("cycling", "Cycling", "cardio", None),
    ActivityType("swimming", "Swimming", "cardio", None),
    ActivityType("hiit", "HIIT", "cardio", None),
    ActivityType("dance", "Dance", "cardio", None),
    ActivityType("strength_training", "Strength training", "strength", None),
    ActivityType("home_workout", "Home workout", "strength", None),
    ActivityType("yoga", "Yoga", "flexibility", None),
    ActivityType("pilates", "Pilates", "flexibility", None),
    ActivityType("sports", "Sports", "sport", None),
    ActivityType("squat", "Squats", "strength", "exercise_module"),
    ActivityType("pushup", "Push-ups", "strength", "exercise_module"),
    ActivityType("bicep_curl", "Bicep curls", "strength", "exercise_module"),
    ActivityType("high_knee", "High knees", "cardio", "exercise_module"),
)
ACTIVITY_CODES = tuple(a.code for a in ACTIVITY_TYPES)
