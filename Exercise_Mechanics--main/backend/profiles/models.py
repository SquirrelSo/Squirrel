"""Request models for profile details, shared by onboarding (POST /api/users) and the per-section
update routes. Every enumerated answer is closed; unknown fields are rejected."""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.profiles.vocab import (
    ABOUT_YOU_AGE,
    ABOUT_YOU_GENDERS,
    ACTIVITY_CODES,
    ACTIVITY_LEVELS,
    ALCOHOL,
    BODY_FAT_PCT,
    BODY_TYPES,
    CGPA,
    CONSENT_CATEGORIES,
    DIETS,
    EXPERIENCE,
    FITNESS_LEVELS,
    HEIGHT_CM,
    INTEREST_MAX,
    INTEREST_MIN,
    MAX_DECLARED_ACTIVITIES,
    MEASUREMENT_FIELDS,
    MEASUREMENT_SOURCES,
    PRIMARY_GOALS,
    SLEEP_HOURS,
    SMOKING,
    WAIST_CM,
    WEIGHT_KG,
    WORKOUT_TIMES,
    WORKOUTS_PER_WEEK,
)

# A client clock a little ahead of ours is not a future measurement.
_CLOCK_SKEW = timedelta(minutes=5)


def _unique(values: list, what: str) -> list:
    if len(set(values)) != len(values):
        raise ValueError(f"{what} must not repeat")
    return values


def check_date_of_birth(raw: str, today: date | None = None) -> str:
    try:
        born = date.fromisoformat(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("date_of_birth must be a real date in YYYY-MM-DD form") from exc
    if born.year < 1900 or born > (today or date.today()):
        raise ValueError("date_of_birth must be between 1900 and today")
    return born.isoformat()


class FitnessAnswers(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fitness_level: Literal[FITNESS_LEVELS]
    activity_level: Literal[ACTIVITY_LEVELS] | None = None
    primary_goal: Literal[PRIMARY_GOALS] | None = None


class DeclaredActivity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    activity: Literal[ACTIVITY_CODES]
    experience: Literal[EXPERIENCE] | None = None
    interest: int = Field(default=3, ge=INTEREST_MIN, le=INTEREST_MAX)


class ActivitiesAnswers(BaseModel):
    model_config = ConfigDict(extra="forbid")

    activities: list[DeclaredActivity] = Field(max_length=MAX_DECLARED_ACTIVITIES)

    @field_validator("activities")
    @classmethod
    def _no_repeats(cls, values: list[DeclaredActivity]) -> list[DeclaredActivity]:
        _unique([v.activity for v in values], "activities")
        return values


class PhysiqueAnswers(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body_type: Literal[BODY_TYPES]


class HabitsAnswers(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preferred_workout_times: list[Literal[WORKOUT_TIMES]] = Field(default_factory=list,
                                                                  max_length=len(WORKOUT_TIMES))
    workouts_per_week_goal: int | None = Field(default=None, ge=WORKOUTS_PER_WEEK[0], le=WORKOUTS_PER_WEEK[1])
    avg_sleep_hours: float | None = Field(default=None, ge=SLEEP_HOURS[0], le=SLEEP_HOURS[1])
    diet: Literal[DIETS] | None = None
    smoking: Literal[SMOKING] | None = None
    alcohol: Literal[ALCOHOL] | None = None

    @field_validator("preferred_workout_times")
    @classmethod
    def _no_repeats(cls, values: list[str]) -> list[str]:
        return _unique(values, "preferred_workout_times")


class ConsentDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: Literal[CONSENT_CATEGORIES]
    granted: bool
    # Which wording of the privacy notice the user agreed to, so a later change can re-ask.
    policy_version: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9._-]+$")


class MeasurementIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    height_cm: float | None = Field(default=None, ge=HEIGHT_CM[0], le=HEIGHT_CM[1])
    weight_kg: float | None = Field(default=None, ge=WEIGHT_KG[0], le=WEIGHT_KG[1])
    body_fat_pct: float | None = Field(default=None, ge=BODY_FAT_PCT[0], le=BODY_FAT_PCT[1])
    waist_cm: float | None = Field(default=None, ge=WAIST_CM[0], le=WAIST_CM[1])
    measured_at: datetime | None = None  # defaults to now; a naive time is taken as UTC
    source: Literal[MEASUREMENT_SOURCES] = "self_reported"

    @model_validator(mode="after")
    def _meaningful(self) -> MeasurementIn:
        if all(getattr(self, field) is None for field in MEASUREMENT_FIELDS):
            raise ValueError(f"give at least one of {', '.join(MEASUREMENT_FIELDS)}")
        if self.measured_at is not None:
            moment = self.measured_at if self.measured_at.tzinfo else self.measured_at.replace(tzinfo=timezone.utc)
            if moment > datetime.now(timezone.utc) + _CLOCK_SKEW:
                raise ValueError("measured_at cannot be in the future")
            if moment.year < 1900:
                raise ValueError("measured_at is too far in the past")
        return self


class SignUpDetails(BaseModel):
    """Sign-up page 2: the optional questions, all in one request. Each section may be skipped.
    Physique and habits are accepted only with their consent granted."""
    model_config = ConfigDict(extra="forbid")

    fitness: FitnessAnswers | None = None
    activities: list[DeclaredActivity] | None = Field(default=None, max_length=MAX_DECLARED_ACTIVITIES)
    physique: PhysiqueAnswers | None = None
    habits: HabitsAnswers | None = None
    consents: list[ConsentDecision] = Field(default_factory=list, max_length=len(CONSENT_CATEGORIES))

    @field_validator("activities")
    @classmethod
    def _no_repeated_activities(cls, values: list[DeclaredActivity] | None) -> list[DeclaredActivity] | None:
        if values is not None:
            _unique([v.activity for v in values], "activities")
        return values

    @field_validator("consents")
    @classmethod
    def _one_decision_per_category(cls, values: list[ConsentDecision]) -> list[ConsentDecision]:
        _unique([v.category for v in values], "consent categories")
        return values

    def sections(self) -> dict:
        return {
            "fitness": self.fitness.model_dump() if self.fitness else None,
            "activities": [a.model_dump() for a in self.activities] if self.activities is not None else None,
            "physique": self.physique.model_dump() if self.physique else None,
            "habits": self.habits.model_dump() if self.habits else None,
        }


_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
_INDIAN_MOBILE = re.compile(r"^\+91[6-9]\d{9}$")  # E.164


class ProfileDetailsIn(BaseModel):
    """The app's "About you" form (PUT /api/me/profile-details), field for field. The rules are the
    ones campus-service used before ADR-032 moved these details here (its migration 004) and the app's
    own checks (mobile-4/src/logic/profileValidation.ts).
    Checks against the account (age, college_email, the two emails differing) are in
    service.save_profile_details."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    full_name: str = Field(min_length=2, max_length=60)
    personal_email: str = Field(max_length=254)
    college_email: str = Field(max_length=254)
    phone: str = Field(max_length=16)
    gender: Literal[ABOUT_YOU_GENDERS]
    # Age is never stored: it comes from the date of birth, which the form sends when the account has
    # none yet (code sign-in asks for none) or to correct it. `age`, if sent, must agree with it.
    date_of_birth: str | None = None
    age: int | None = Field(default=None, ge=ABOUT_YOU_AGE[0], le=ABOUT_YOU_AGE[1])
    course: str = Field(min_length=1, max_length=60)
    cgpa: float | None = Field(default=None, ge=CGPA[0], le=CGPA[1])

    @field_validator("date_of_birth")
    @classmethod
    def _real_date(cls, value: str | None) -> str | None:
        return None if value is None else check_date_of_birth(value)

    @field_validator("full_name")
    @classmethod
    def _a_name(cls, value: str) -> str:
        if not any(ch.isalpha() for ch in value):
            raise ValueError("enter your full name")
        return " ".join(value.split())

    @field_validator("personal_email", "college_email")
    @classmethod
    def _an_email(cls, value: str) -> str:
        if not _EMAIL.fullmatch(value):
            raise ValueError("enter a valid email address")
        return value.lower()

    @field_validator("phone")
    @classmethod
    def _e164_mobile(cls, value: str) -> str:
        if not _INDIAN_MOBILE.fullmatch(value):
            raise ValueError("phone must be an Indian mobile in E.164 form, e.g. +919876543210")
        return value

    @field_validator("cgpa")
    @classmethod
    def _two_decimals(cls, value: float | None) -> float | None:
        if value is not None and abs(value * 100 - round(value * 100)) > 1e-6:
            raise ValueError("CGPA can have at most 2 decimals")
        return value
