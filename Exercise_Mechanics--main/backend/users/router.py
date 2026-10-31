"""User REST routes.

  • POST /api/users                 — sign-up page 1 with a password: creates the sign-in account
                                      and returns its tokens. Page 2's questions are
                                      PUT /api/users/{id}/details (backend/profiles/).
  • GET  /api/users/{id}            — profile (dashboard height/weight/BMI; latest measurements).
  • PUT  /api/users/{id}/profile    — save page 1's details onto an account made elsewhere (the
                                      app registers with email + name, then fills this in).
Every /api/users/{id}/... route needs that user's bearer token (auth/deps.require_path_user).
  • GET/POST /api/users/{id}/skill  — read/persist the chosen skill level.
Minimal session creation lives in backend/sessions/router.py.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend import config
from backend.auth.router import check_sign_up_email, count_sign_up, token_pair
from backend.auth.store import EmailTaken
from backend.core.ids import safe_user_id
from backend.profiles import service as profiles
from backend.profiles.models import check_date_of_birth
from backend.profiles.vocab import GENDERS, HEIGHT_CM, WEIGHT_KG
from backend.users.store import read_skill, write_skill

router = APIRouter(prefix="/api")


class UserProfile(BaseModel):
    """Sign-up page 1. Field names match the frontend OnboardingForm one-to-one. The optional
    questions (fitness, activities, physique, habits) are page 2: PUT /api/users/{id}/details."""
    first_name:    str = Field(min_length=1, max_length=80)
    last_name:     str = Field(min_length=1, max_length=80)
    gender:        Literal[GENDERS]
    height_cm:     float = Field(ge=HEIGHT_CM[0], le=HEIGHT_CM[1])
    weight_kg:     float = Field(ge=WEIGHT_KG[0], le=WEIGHT_KG[1])
    date_of_birth: str   # ISO date (YYYY-MM-DD) from the client date picker; age is derived from it
    mobile:        str = Field(min_length=3, max_length=32)
    email:         str = Field(min_length=3, max_length=200)
    # Required while sign-in is enforced; only the browser coach, with auth switched off for local
    # development, still creates password-less users.
    password:      str | None = Field(default=None, min_length=8, max_length=200)
    # The emailed sign-up code (POST /api/auth/email-code), needed with a password while
    # verification is on: the same gate as /api/auth/register.
    code:          str | None = Field(default=None, min_length=6, max_length=6, pattern=r"^\d{6}$")

    @field_validator("date_of_birth")
    @classmethod
    def _real_date(cls, value: str) -> str:
        return check_date_of_birth(value)


@router.post("/users")
def create_user(profile: UserProfile, request: Request) -> dict:
    if profile.password is None and config.auth_required():
        raise HTTPException(status_code=422, detail="password is required to create an account")
    verified = False
    if profile.password is not None:
        count_sign_up(request)  # the same sign-up limit and email gate as /api/auth/register
        verified = check_sign_up_email(profile.email, profile.code)
    try:
        identity = profiles.onboard(profile.model_dump(exclude={"password", "code"}), password=profile.password,
                                    email_verified=verified)
    except EmailTaken:
        raise HTTPException(status_code=409, detail="an account with this email already exists") from None
    return {**identity, **token_pair(identity["user_id"], verified=verified)} if profile.password else identity


class CoachProfile(BaseModel):
    """The page-1 details for an existing account. Same rules as UserProfile."""
    model_config = ConfigDict(extra="forbid")

    first_name:    str | None = Field(default=None, min_length=1, max_length=80)
    last_name:     str | None = Field(default=None, min_length=1, max_length=80)
    gender:        Literal[GENDERS]
    height_cm:     float = Field(ge=HEIGHT_CM[0], le=HEIGHT_CM[1])
    weight_kg:     float = Field(ge=WEIGHT_KG[0], le=WEIGHT_KG[1])
    date_of_birth: str
    mobile:        str = Field(min_length=3, max_length=32)

    @field_validator("date_of_birth")
    @classmethod
    def _real_date(cls, value: str) -> str:
        return check_date_of_birth(value)


@router.put("/users/{user_id}/profile")
def save_profile(user_id: str, body: CoachProfile) -> dict:
    try:
        return profiles.complete_profile(safe_user_id(user_id), body.model_dump())
    except profiles.ProfileError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from None


@router.get("/users/{user_id}")
def get_user(user_id: str) -> dict:
    """Return a user's saved profile.json (height, weight, …) — the dashboard reads this to
    show profile fields + compute BMI. Height and weight are the latest logged measurements.
    404 if the user has no profile."""
    profile = profiles.profile_with_latest_body(safe_user_id(user_id))
    if profile is None:
        raise HTTPException(status_code=404, detail="user not found")
    return profile


class SkillUpdate(BaseModel):
    skill_level: str


@router.get("/users/{user_id}/skill")
def get_skill(user_id: str) -> dict:
    """Current skill level + whether it's been explicitly set. `configured` is False for a new
    profile (no skill.json) so the dashboard shows 'Update', not 'Updated'."""
    level, configured = read_skill(safe_user_id(user_id))
    return {"skill_level": level, "configured": configured}


@router.post("/users/{user_id}/skill")
def update_skill(user_id: str, body: SkillUpdate) -> dict:
    """Persist the skill level chosen on the dashboard → users/{id}/skill.json."""
    level = write_skill(safe_user_id(user_id), body.skill_level)
    return {"skill_level": level, "configured": True}
