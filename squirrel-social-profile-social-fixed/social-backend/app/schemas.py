"""Request and response models: the public API contract.

Responses never carry: auth subject, email, role, internal media keys, raw GPS or territory
geometry. Author objects are the minimum a feed row needs to render.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app import rules

RUN_ID_RE = r"^[A-Za-z0-9_-]{1,64}$"

Visibility = Literal["public", "private"]
ActivityType = Literal["run", "ride", "workout", "yoga", "meal"]
FeedKind = Literal["for_you", "following", "nearby"]


class _Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- users


class AvatarLook(_In):
    body: str
    skin: str
    hair: str
    hairColor: str  # noqa: N815 - mirrors the app's AvatarLook
    top: str
    topColor: str  # noqa: N815
    bottom: str
    bottomColor: str  # noqa: N815
    shoeColor: str  # noqa: N815
    accessory: str

    @model_validator(mode="after")
    def _check(self):
        problem = rules.avatar_look_problem(self.model_dump())
        if problem:
            raise ValueError(problem)
        return self


class UserSummary(_Out):
    """Author / list-row shape. Safe for anyone who can see the row."""

    id: uuid.UUID
    username: str
    display_name: str
    avatar_look: dict | None
    avatar_url: str | None
    level: int
    verified: bool


class FollowListItem(UserSummary):
    city_id: str | None
    area: str | None
    interests: list[str]
    followed_at: datetime | None = None
    # Viewer's relationship to this user, so list rows can render Follow buttons without N calls.
    following: bool
    requested: bool
    is_me: bool


class UserPage(BaseModel):
    items: list[FollowListItem]
    next_cursor: str | None


class ProfileUser(_Out):
    id: uuid.UUID
    username: str
    display_name: str
    avatar_look: dict | None
    avatar_url: str | None
    bio: str | None
    city_id: str | None
    area: str | None
    college: str | None
    hostel: str | None
    interests: list[str]
    visibility: Visibility
    verified: bool
    created_at: datetime


class ProfileStats(BaseModel):
    xp: int
    level: int
    level_xp: int
    xp_per_level: int
    xp_synced_at: datetime | None
    streak_days: int
    followers: int
    following: int
    posts: int
    activities: int
    # "47 km this month": verified runs (and measured workouts) of the current local month.
    month: str | None = None
    month_km: float = 0.0
    month_runs: int = 0
    month_workouts: int = 0


class ProfileCrew(BaseModel):
    """A crew the user is in, with how long and how many members vouch for them there."""

    id: uuid.UUID
    name: str
    interest: str
    role: str
    member_since: datetime
    vouches: int


class BadgeOut(_Out):
    id: str
    kind: str
    title: str
    description: str
    awarded_at: datetime


class BadgeProgress(BaseModel):
    current: int
    target: int


class BadgeStatus(BaseModel):
    """One catalogue badge for GET /v1/users/me/badges, in the app's Badge shape."""

    id: str
    name: str
    description: str
    unlocked: bool
    unlocked_at: datetime | None
    progress: BadgeProgress | None  # null when the badge has no measurable progress


class BadgesResponse(BaseModel):
    badges: list[BadgeStatus]


class FollowStatus(BaseModel):
    following: bool
    followed_by: bool
    requested: bool = False


class FollowResult(FollowStatus):
    followers: int
    following_count: int


class ProfileResponse(BaseModel):
    user: ProfileUser
    stats: ProfileStats
    badges: list[BadgeOut]
    crews: list[ProfileCrew] = []
    recent_posts: list[PostOut]
    recent_activities: list[ActivityOut]
    is_me: bool
    # Private profile viewed by a non-follower: identity + counts only.
    restricted: bool
    relationship: FollowStatus | None
    # Only on /users/me/profile: false until the user has picked their own username.
    username_confirmed: bool | None = None


class UpdateProfileRequest(_In):
    username: str | None = None
    display_name: Annotated[str, Field(min_length=1, max_length=rules.DISPLAY_NAME_MAX)] | None = None
    bio: Annotated[str, Field(max_length=rules.BIO_MAX)] | None = None
    city_id: str | None = None
    area: Annotated[str, Field(max_length=rules.AREA_MAX)] | None = None
    college: Annotated[str, Field(max_length=rules.COLLEGE_MAX)] | None = None
    hostel: Annotated[str, Field(max_length=40)] | None = None  # one of GET /v1/community/config's hostels
    interests: list[str] | None = None
    avatar_look: AvatarLook | None = None
    avatar_media_id: uuid.UUID | None = None
    visibility: Visibility | None = None

    @field_validator("display_name", "bio", "area", "college")
    @classmethod
    def _clean(cls, v: str | None):
        return rules.clean_text(v) if v is not None else v

    @field_validator("display_name")
    @classmethod
    def _display_name(cls, v: str | None):
        if v is not None and not v:
            raise ValueError("Display name can't be empty.")
        if v is not None and "\n" in v:
            raise ValueError("Display name must be one line.")
        return v

    @field_validator("city_id")
    @classmethod
    def _city(cls, v: str | None):
        if v is not None and v not in rules.CITY_IDS:
            raise ValueError("Unknown city.")
        return v

    @field_validator("interests")
    @classmethod
    def _interests(cls, v: list[str] | None):
        if v is None:
            return v
        cleaned: list[str] = []
        for item in v:
            t = rules.clean_text(item).replace("\n", " ")
            if not t:
                continue
            if len(t) > rules.INTEREST_MAX_LEN:
                raise ValueError(f"Each interest must be at most {rules.INTEREST_MAX_LEN} characters.")
            if t.lower() not in (c.lower() for c in cleaned):
                cleaned.append(t)
        if len(cleaned) > rules.INTERESTS_MAX:
            raise ValueError(f"Pick at most {rules.INTERESTS_MAX} interests.")
        return cleaned


class UsernameAvailability(BaseModel):
    username: str
    available: bool
    reason: str | None


# --------------------------------------------------------------------------- activities


class ActivityOut(BaseModel):
    id: uuid.UUID
    type: ActivityType
    source: Literal["run_module", "exercise", "manual"]
    verified: bool
    name: str | None
    distance_km: float | None
    duration_minutes: int | None
    pace: str | None
    calories: int | None
    started_at: datetime


class RunActivityRef(_In):
    """Share a Run Module run. Stats are fetched server-side; nothing numeric is accepted."""

    source: Literal["run"]
    run_id: Annotated[str, Field(pattern=RUN_ID_RE)]


class ExistingActivityRef(_In):
    """Share an activity another module already published (POST /internal/v1/activities)."""

    source: Literal["activity"]
    activity_id: uuid.UUID


class ManualActivity(_In):
    """Self-reported (unverified) activity. Runs are not allowed here: they must be measured."""

    source: Literal["manual"]
    type: Literal["ride", "workout", "yoga", "meal"]
    name: Annotated[str, Field(min_length=1, max_length=60)] | None = None
    distance_km: Annotated[float, Field(gt=0, le=500)] | None = None
    duration_minutes: Annotated[int, Field(ge=1, le=24 * 60)] | None = None
    calories: Annotated[int, Field(ge=0, le=10_000)] | None = None

    @model_validator(mode="after")
    def _shape(self):
        if self.name is not None:
            self.name = rules.clean_text(self.name).replace("\n", " ")
        if self.type == "meal":
            if not self.name:
                raise ValueError("A meal needs a name.")
            if self.distance_km is not None or self.duration_minutes is not None:
                raise ValueError("A meal has no distance or duration.")
        elif self.duration_minutes is None:
            raise ValueError("duration_minutes is required.")
        if self.type == "ride" and self.distance_km is None:
            raise ValueError("A ride needs distance_km.")
        if self.type == "workout" and not self.name:
            raise ValueError("A workout needs a name.")
        if self.type in ("yoga", "workout") and self.distance_km is not None:
            raise ValueError(f"{self.type} has no distance.")
        return self


ActivityInput = Annotated[RunActivityRef | ExistingActivityRef | ManualActivity, Field(discriminator="source")]


class InternalActivityIn(_In):
    """Service-to-service publish (Run Module worker, Exercise backend, future modules)."""

    user_subject: Annotated[str, Field(min_length=1, max_length=255)]
    type: ActivityType
    source: Literal["run_module", "exercise"]
    source_ref: Annotated[str, Field(min_length=1, max_length=128)]
    started_at: datetime
    name: Annotated[str, Field(max_length=60)] | None = None
    distance_m: Annotated[int, Field(ge=0, le=1_000_000)] | None = None
    duration_s: Annotated[int, Field(ge=0, le=7 * 86_400)] | None = None
    calories: Annotated[int, Field(ge=0, le=20_000)] | None = None
    metrics: dict = Field(default_factory=dict)

    @field_validator("started_at")
    @classmethod
    def _aware(cls, v: datetime):
        if v.tzinfo is None:
            raise ValueError("started_at must include a timezone.")
        return v

    @field_validator("metrics")
    @classmethod
    def _small_metrics(cls, v: dict):
        # Summary numbers only; anything that looks like a route/coordinates is refused.
        if len(v) > 20 or any(not isinstance(k, str) or len(k) > 40 for k in v):
            raise ValueError("metrics: at most 20 short keys.")
        for k, val in v.items():
            if re.search(r"(lat|lng|lon|coord|geo|route|polyline|path|point)", k, re.I):
                raise ValueError("metrics must not contain location data.")
            if not isinstance(val, (int, float, str, bool)) or (isinstance(val, str) and len(val) > 60):
                raise ValueError("metrics values must be short scalars.")
        return v


class InternalActivityOut(BaseModel):
    activity_id: uuid.UUID
    created: bool


# --------------------------------------------------------------------------- posts


class Backdrop(_In):
    scene: str = "city-sunset"
    seed: Annotated[int, Field(ge=0, le=999)] = 0

    @field_validator("scene")
    @classmethod
    def _scene(cls, v: str):
        if v not in rules.SCENES:
            raise ValueError("Unknown backdrop scene.")
        return v


class BackdropOut(BaseModel):
    scene: str
    seed: int


class CreatePostRequest(_In):
    caption: Annotated[str, Field(max_length=rules.CAPTION_MAX)] = ""
    backdrop: Backdrop = Field(default_factory=Backdrop)
    sticker: str | None = None
    crew_name: Annotated[str, Field(max_length=rules.CREW_NAME_MAX)] | None = None
    city_id: str | None = None
    area: Annotated[str, Field(max_length=rules.AREA_MAX)] | None = None
    media_id: uuid.UUID | None = None
    activity: ActivityInput | None = None

    @field_validator("caption", "crew_name", "area")
    @classmethod
    def _clean(cls, v: str | None):
        return rules.clean_text(v) if v is not None else v

    @field_validator("sticker")
    @classmethod
    def _sticker(cls, v: str | None):
        if v is not None and v not in rules.POST_STICKERS:
            raise ValueError("Unknown sticker.")
        return v

    @field_validator("city_id")
    @classmethod
    def _city(cls, v: str | None):
        if v is not None and v not in rules.CITY_IDS:
            raise ValueError("Unknown city.")
        return v

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.caption and self.activity is None and self.media_id is None:
            raise ValueError("A post needs a caption, an activity or a photo.")
        return self


class PostOut(BaseModel):
    id: uuid.UUID
    author: UserSummary
    caption: str
    activity: ActivityOut | None
    city_id: str | None
    area: str | None
    backdrop: BackdropOut
    media_url: str | None
    sticker: str | None
    crew_name: str | None
    likes_count: int
    comments_count: int
    liked_by_me: bool
    saved_by_me: bool
    is_mine: bool
    # Viewer follows the author (accepted) / has a pending request — so cards render Follow correctly.
    following_author: bool
    requested_author: bool
    created_at: datetime


class FeedResponse(BaseModel):
    items: list[PostOut]
    next_cursor: str | None


class LikeResult(BaseModel):
    liked: bool
    likes_count: int


class SaveResult(BaseModel):
    saved: bool


# --------------------------------------------------------------------------- comments


class CreateCommentRequest(_In):
    body: Annotated[str, Field(min_length=1, max_length=rules.COMMENT_MAX)]

    @field_validator("body")
    @classmethod
    def _clean(cls, v: str):
        v = rules.clean_text(v)
        if not v:
            raise ValueError("Comment can't be empty.")
        return v


class CommentOut(BaseModel):
    id: uuid.UUID
    post_id: uuid.UUID
    author: UserSummary
    body: str
    created_at: datetime
    can_delete: bool


class CommentPage(BaseModel):
    items: list[CommentOut]
    next_cursor: str | None
    total: int


# --------------------------------------------------------------------------- media


class CreateUploadRequest(_In):
    purpose: Literal["post", "avatar"]
    content_type: str
    byte_size: Annotated[int, Field(gt=0)]


class UploadTicket(BaseModel):
    media_id: uuid.UUID
    upload_url: str
    method: Literal["PUT"]
    headers: dict[str, str]
    expires_at: datetime


class MediaOut(BaseModel):
    media_id: uuid.UUID
    status: Literal["pending", "ready"]
    url: str | None


ProfileResponse.model_rebuild()
