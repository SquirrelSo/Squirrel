"""Request and response models of the community routes: membership and referrals, crews, events,
check-ins, challenges, notifications, boards and daily stats. Same conventions as schemas.py."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from app import rules
from app.schemas import UserSummary

Interest = Literal["running", "walking", "cycling", "yoga", "hiit", "climbing", "nutrition", "other"]
BoardWindow = Literal["daily", "weekly"]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _clean(v: str | None) -> str | None:
    return rules.clean_text(v) if v is not None else v


def _one_line(v: str | None) -> str | None:
    v = _clean(v)
    if v is not None and "\n" in v:
        raise ValueError("Must be one line.")
    return v


# --------------------------------------------------------------------------- membership


class FoundingOut(BaseModel):
    badge_id: str
    title: str
    rank: int


class MembershipOut(BaseModel):
    position: int                 # where you joined the line
    effective_position: int       # where you are now: everyone who skipped it goes first
    members_total: int
    referral_code: str
    invite_url: str | None
    referrals: int
    referrals_to_skip: int
    skipped: bool
    admitted: bool                # everyone is, for now
    email_verified: bool
    founding: FoundingOut | None
    referred_by: UserSummary | None


class ClaimReferralRequest(_In):
    code: Annotated[str, Field(min_length=4, max_length=16)]


class CommunityConfig(BaseModel):
    hostels: list[str]
    founding_first: int
    founding_total: int
    referrals_to_skip: int
    timezone: str


# --------------------------------------------------------------------------- ambassador


class AmbassadorField(BaseModel):
    key: str
    label: str
    type: Literal["text", "multiline", "select"]
    required: bool
    max_length: int | None = None
    options: list[str] | None = None
    placeholder: str | None = None
    prefill: str | None = None


class AmbassadorApplication(BaseModel):
    id: uuid.UUID
    status: Literal["pending", "under_review", "approved", "rejected", "suspended"]
    submitted_at: datetime
    decided_at: datetime | None
    message: str | None


class AmbassadorState(BaseModel):
    open: bool
    closed_reason: str | None
    application: AmbassadorApplication | None
    fields: list[AmbassadorField]


class CreateAmbassadorApplication(_In):
    answers: dict[str, str]
    idempotency_key: Annotated[str, Field(max_length=120)]


class AdminAmbassadorDecision(_In):
    status: Literal["under_review", "approved", "rejected"]
    message: str | None = None


class AdminAmbassadorApplication(AmbassadorApplication):
    user: UserSummary
    answers: dict[str, str]
    form_version: int


class AdminAmbassadorList(BaseModel):
    items: list[AdminAmbassadorApplication]


# --------------------------------------------------------------------------- crews


class CreateCrewRequest(_In):
    name: Annotated[str, Field(min_length=3, max_length=40)]
    tagline: Annotated[str, Field(max_length=120)] = ""
    interest: Interest
    meets: Annotated[str, Field(max_length=60)] = ""
    scope: Literal["campus", "online"] = "campus"
    hostel: str | None = None

    @field_validator("name", "tagline", "meets")
    @classmethod
    def _one_line_fields(cls, v):
        return _one_line(v)


class CrewOut(BaseModel):
    id: uuid.UUID
    name: str
    tagline: str
    interest: str
    meets: str
    scope: str
    hostel: str | None
    members_count: int
    created_at: datetime
    is_member: bool
    my_role: str | None
    member_since: datetime | None
    preview: list[UserSummary]    # a few members, for the avatar row


class CrewPage(BaseModel):
    items: list[CrewOut]
    next_cursor: str | None


class CrewMemberOut(BaseModel):
    user: UserSummary
    role: str
    member_since: datetime
    vouches: int
    vouched_by_me: bool
    is_me: bool


class CrewDetail(CrewOut):
    members: list[CrewMemberOut]
    upcoming_events: list[EventOut]


class VouchResult(BaseModel):
    vouches: int
    vouched_by_me: bool


# --------------------------------------------------------------------------- events


class CreateEventRequest(_In):
    title: Annotated[str, Field(min_length=3, max_length=80)]
    description: Annotated[str, Field(max_length=500)] = ""
    kind: Interest
    venue: Annotated[str, Field(max_length=80)] = ""
    online: bool = False
    starts_at: datetime
    ends_at: datetime | None = None
    capacity: Annotated[int, Field(ge=2, le=1000)] | None = None
    crew_id: uuid.UUID | None = None

    @field_validator("title", "venue")
    @classmethod
    def _one_line_fields(cls, v):
        return _one_line(v)

    @field_validator("description")
    @classmethod
    def _clean_description(cls, v):
        return _clean(v)

    @field_validator("starts_at", "ends_at")
    @classmethod
    def _aware(cls, v: datetime | None):
        if v is not None and v.tzinfo is None:
            raise ValueError("Include a time zone (e.g. 2026-10-01T06:00:00+05:30).")
        return v


class EventOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str
    kind: str
    venue: str
    online: bool
    starts_at: datetime
    ends_at: datetime | None
    capacity: int | None
    going_count: int
    cancelled: bool
    crew: CrewRef | None
    host: UserSummary
    my_rsvp: Literal["going", "interested"] | None
    checked_in: bool
    attendees: list[UserSummary]  # a few of those going


class CrewRef(BaseModel):
    id: uuid.UUID
    name: str
    interest: str


class EventPage(BaseModel):
    items: list[EventOut]
    next_cursor: str | None


class RsvpRequest(_In):
    status: Literal["going", "interested"] = "going"


class CheckInRequest(_In):
    """Tell up to 5 friends you've arrived. A friend is someone who follows you, or shares a crew
    with you; anyone else in the list is skipped."""

    notify_user_ids: Annotated[list[uuid.UUID], Field(max_length=5)] = []
    note: Annotated[str, Field(max_length=140)] = ""

    @field_validator("note")
    @classmethod
    def _clean_note(cls, v):
        return _one_line(v)


class MeetupCheckInRequest(CheckInRequest):
    place: Annotated[str, Field(min_length=2, max_length=80)]

    @field_validator("place")
    @classmethod
    def _clean_place(cls, v):
        return _one_line(v)


class CheckInOut(BaseModel):
    id: uuid.UUID
    place: str
    event_id: uuid.UUID | None
    note: str
    notified: int
    created_at: datetime


# --------------------------------------------------------------------------- challenges


class CreateChallengeRequest(_In):
    opponent_id: uuid.UUID
    metric: Literal["km", "workouts"] = "km"
    days: Annotated[int, Field(ge=1, le=30)] = 7


class ChallengeSide(BaseModel):
    user: UserSummary
    score: float


class ChallengeOut(BaseModel):
    id: uuid.UUID
    metric: str
    days: int
    status: str
    created_at: datetime
    starts_at: datetime | None
    ends_at: datetime | None
    me: ChallengeSide
    opponent: ChallengeSide
    i_challenged: bool
    winner_id: uuid.UUID | None


class ChallengeList(BaseModel):
    items: list[ChallengeOut]


# --------------------------------------------------------------------------- notifications


class NotificationOut(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    body: str
    data: dict
    actor: UserSummary | None
    created_at: datetime
    read: bool


class NotificationPage(BaseModel):
    items: list[NotificationOut]
    next_cursor: str | None
    unread: int


class MarkReadRequest(_In):
    ids: Annotated[list[uuid.UUID], Field(max_length=100)] | None = None  # None: all


class UnreadCount(BaseModel):
    unread: int


class PushTokenRequest(_In):
    token: Annotated[str, Field(min_length=10, max_length=255, pattern=r"^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$")]
    platform: Literal["ios", "android", "web"]


RUN_MODULE_KINDS = ("territory_lost", "territory_captured", "territory_expired")
CAMPUS_KINDS = (
    "territory.stolen", "territory.challenged", "territory.defended", "zone.claimed",
    "challenge.invitation", "challenge.reminder", "challenge.updated",
    "event.reminder", "meetup.check_in", "meetup.invited", "meetup.accepted", "meetup.declined", "meetup.cancelled",
    "activity.verification_complete",
)
# Exercise (Partner Hunt Connect). Written by the caller like campus kinds. partner.request names no
# actor: the two aren't connected yet, so Exercise sends the anonymous card name in the title instead.
EXERCISE_KINDS = ("partner.request", "partner.accepted", "shared_workout.invited", "shared_workout.finished")
# Written by the caller too (CONTRACT §2): the Run Module's level-up, campus-service's Bubble.
XP_KINDS = ("xp.level_up",)
BUBBLE_KINDS = ("bubble.activity",)
NotificationKind = Literal[RUN_MODULE_KINDS + CAMPUS_KINDS + EXERCISE_KINDS + XP_KINDS + BUBBLE_KINDS]  # type: ignore[valid-type]


class InternalNotificationIn(_In):
    """From the Run Module (territory steals), campus-service, or Exercise (Partner Hunt Connect).

    Run Module kinds: the text is written here, from `kind` and the names Social knows; `title` and
    `body` must be left out. Campus and Exercise kinds: the caller writes `title` (and optionally `body`) and may
    put `{actor}` where the actor's name goes. Social fills it with the actor's display name, or with
    `actor_fallback` when there is no actor, Social doesn't know them, or the two are blocked either
    way."""

    user_subject: Annotated[str, Field(min_length=1, max_length=255)]
    kind: NotificationKind
    actor_subject: Annotated[str, Field(min_length=1, max_length=255)] | None = None
    title: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    body: Annotated[str, Field(max_length=400)] | None = None
    actor_fallback: Annotated[str, Field(min_length=1, max_length=40)] = "Someone"
    data: dict = {}
    dedupe_key: Annotated[str, Field(min_length=1, max_length=120)]

    @model_validator(mode="after")
    def _text_by_kind(self):
        if self.kind in RUN_MODULE_KINDS:
            if self.title is not None or self.body is not None:
                raise ValueError("title and body are written by Social for Run Module kinds; leave them out.")
        elif self.title is None:
            raise ValueError("title is required for this kind.")
        return self


class InternalNotificationOut(BaseModel):
    created: bool
    notification_id: uuid.UUID | None  # Social's id: the new one, or the existing one on a retry


class InternalPeopleResolveIn(_In):
    """From another service (campus-service) that knows people by their token `sub` and needs
    Social's names and public profile ids. The only place a subject↔profile mapping leaves Social."""

    subjects: Annotated[list[Annotated[str, Field(min_length=1, max_length=255)]], Field(max_length=200)] = []
    profile_ids: Annotated[list[uuid.UUID], Field(max_length=200)] = []


class InternalPerson(BaseModel):
    subject: str
    profile_id: uuid.UUID
    username: str
    display_name: str
    avatar_url: str | None
    hostel: str | None
    level: int


class InternalPeopleResolveOut(BaseModel):
    people: list[InternalPerson]


Subject = Annotated[str, Field(min_length=1, max_length=255)]


class InternalCrewMembershipsIn(_In):
    """Login subjects whose crews another service (campus-service) needs, e.g. for crew territory."""

    subjects: Annotated[list[Subject], Field(min_length=1, max_length=200)]


class InternalCrewRef(BaseModel):
    id: uuid.UUID
    name: str
    role: str  # owner | member
    joined_at: datetime


class InternalCrewMemberships(BaseModel):
    subject: str
    crews: list[InternalCrewRef]  # oldest membership first; [] for no crews or a subject Social hasn't seen


class InternalCrewMembershipsOut(BaseModel):
    people: list[InternalCrewMemberships]


class InternalCrewsLookupIn(_In):
    crew_ids: Annotated[list[uuid.UUID], Field(min_length=1, max_length=200)]


class InternalCrewMember(BaseModel):
    subject: str
    role: str
    joined_at: datetime


class InternalCrew(BaseModel):
    id: uuid.UUID
    name: str
    interest: str
    scope: str
    hostel: str | None
    members_count: int
    members: list[InternalCrewMember]  # oldest first


class InternalCrewsLookupOut(BaseModel):
    crews: list[InternalCrew]  # in request order; unknown ids left out


class InternalCrewsCountOut(BaseModel):
    crews_total: int  # crews with at least one member
    as_of: datetime


class InternalBlocksOut(BaseModel):
    """Everyone `subject` must not be shown to or paired with: blocked by them or blocking them.
    Callers cache it for at most 30 seconds and fail closed when they can't get a fresh one."""

    subject: str
    blocked: list[str]  # token subjects, either direction
    as_of: datetime


class InternalBlockPair(_In):
    blocker: Subject
    blocked: Subject


class InternalBlocksImportIn(_In):
    """Existing blocks from another service's own table (campus-service, Partner Hunt), by subject."""

    blocks: Annotated[list[InternalBlockPair], Field(max_length=1000)]


class InternalBlocksImportOut(BaseModel):
    imported: int  # new rows
    already: int  # already blocked in Social
    skipped: int  # self-blocks


# --------------------------------------------------------------------------- boards & stats


class XpBoardEntry(BaseModel):
    rank: int
    xp: int
    user: UserSummary
    hostel: str | None
    is_me: bool


class XpBoard(BaseModel):
    window: BoardWindow
    day: date
    entries: list[XpBoardEntry]
    me: XpBoardEntry | None
    available: bool           # false when the Run Module could not be reached


class HostelEntry(BaseModel):
    rank: int
    hostel: str
    xp: int
    members: int
    active: int               # members who earned XP in the window
    is_mine: bool


class HostelBoard(BaseModel):
    window: BoardWindow
    day: date
    enabled: bool             # false until SOCIAL_HOSTELS is set
    entries: list[HostelEntry]
    available: bool


class DayStats(BaseModel):
    day: date
    active_members: int
    runs: int
    km: float
    workouts: int


class MyDay(BaseModel):
    runs: int
    km: float
    workouts: int


class DailyStats(BaseModel):
    timezone: str
    today: DayStats
    me_today: MyDay
    days: list[DayStats]      # newest first, today included


class MonthVerification(BaseModel):
    """"47 km this month": verified runs only (measured by the Run Module, not typed in)."""

    month: str                # YYYY-MM
    km: float
    runs: int
    workouts: int



# --------------------------------------------------------------------------- Squirrel Dates & blocks


class DatesSettingsRequest(_In):
    enabled: bool


class DatesSettings(BaseModel):
    enabled: bool
    # False until campus zones are configured (SOCIAL_ZONES_FILE): opting in is allowed, nothing is suggested.
    zones_ready: bool


class ZoneRef(BaseModel):
    id: str
    name: str


class DateSuggestionOut(BaseModel):
    """Advisory: a person, a zone and a time. Nothing is sent to anyone; to meet, plan an event."""

    id: str                   # the suggested person's id; POST …/{id}/dismiss hides them for a while
    user: UserSummary
    reason: str
    zone: ZoneRef
    suggested_time: datetime | None


class DateSuggestions(BaseModel):
    available: bool           # False only when campus zones aren't configured
    enabled: bool             # the viewer's opt-in
    reason: str | None
    suggestions: list[DateSuggestionOut]


class BlockResult(BaseModel):
    user_id: uuid.UUID
    blocked: bool


class BlockList(BaseModel):
    items: list[UserSummary]

CrewDetail.model_rebuild()
EventOut.model_rebuild()


# --------------------------------------------------------------------------- notification preferences


def _nonempty(v: str | None) -> str | None:
    if v is not None and not v:
        raise ValueError("Can't be blank.")
    return v


NotificationCategory = Literal["xp", "challenges", "territory", "buddies", "workouts", "meetups", "bubble",
                               "crews", "ambassador", "social", "system"]


class CategoryChannels(BaseModel):
    push: bool
    in_app: bool
    mutable: bool


class NotificationPreferencesOut(BaseModel):
    categories: dict[str, CategoryChannels]
    quiet_hours_start: int | None   # minutes after local midnight
    quiet_hours_end: int | None
    timezone: str
    updated_at: datetime | None


class CategoryChannelsPatch(_In):
    push: StrictBool | None = None
    in_app: StrictBool | None = None


class NotificationPreferencesPatch(_In):
    """Only what is sent changes. Quiet hours are set or cleared together (both null = none)."""

    categories: dict[NotificationCategory, CategoryChannelsPatch] | None = None
    quiet_hours_start: Annotated[int, Field(ge=0, le=1439)] | None = None
    quiet_hours_end: Annotated[int, Field(ge=0, le=1439)] | None = None
    timezone: Annotated[str, Field(min_length=1, max_length=64)] | None = None

    @model_validator(mode="after")
    def _pairs(self):
        sent = self.model_fields_set
        if ("quiet_hours_start" in sent) != ("quiet_hours_end" in sent):
            raise ValueError("Send quiet_hours_start and quiet_hours_end together.")
        if (self.quiet_hours_start is None) != (self.quiet_hours_end is None):
            raise ValueError("Quiet hours need both a start and an end (or both null to turn them off).")
        if self.quiet_hours_start is not None and self.quiet_hours_start == self.quiet_hours_end:
            raise ValueError("Quiet hours can't start and end at the same minute.")
        return self


class AnnouncementRequest(_In):
    title: Annotated[str, Field(min_length=1, max_length=120)]
    body: Annotated[str, Field(max_length=240)] = ""
    route: Annotated[str, Field(min_length=1, max_length=100, pattern=r"^/[A-Za-z0-9/_-]*$")] | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, v):
        return _nonempty(_one_line(v))

    @field_validator("body")
    @classmethod
    def _body(cls, v):
        return _clean(v)


class AnnouncementOut(BaseModel):
    id: uuid.UUID
    recipients: int


# --------------------------------------------------------------------------- ambassador programme


class AmbassadorCounts(BaseModel):
    referred: int
    verified: int
    activated: int
    rewarded: int
    referral_xp: int
    task_xp: int


class AmbassadorMe(BaseModel):
    status: Literal["active", "suspended"]
    approved_at: datetime
    suspended_at: datetime | None
    suspension_reason: str | None
    referral_code: str
    invite_url: str | None
    counts: AmbassadorCounts


class ReferralPerson(BaseModel):
    id: uuid.UUID
    display_name: str
    avatar_look: dict | None
    avatar_url: str | None


class AmbassadorReferral(BaseModel):
    user: ReferralPerson
    signup_at: datetime
    verified: bool
    activated: bool
    reward_eligible: bool
    rewarded: bool


class AmbassadorReferralPage(BaseModel):
    items: list[AmbassadorReferral]
    next_cursor: str | None


class AmbassadorTaskOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str
    xp_reward: int
    starts_at: datetime
    ends_at: datetime | None
    active: bool


class MySubmission(BaseModel):
    id: uuid.UUID
    status: Literal["submitted", "approved", "rejected"]
    submitted_at: datetime
    reviewed_at: datetime | None


class AmbassadorTaskWithMine(AmbassadorTaskOut):
    submission: MySubmission | None


class AmbassadorTaskList(BaseModel):
    items: list[AmbassadorTaskWithMine]


class SubmitTaskRequest(_In):
    evidence: Annotated[str, Field(min_length=1, max_length=1000)]

    @field_validator("evidence")
    @classmethod
    def _evidence(cls, v):
        return _nonempty(_clean(v))


class AmbassadorLeaderboardEntry(BaseModel):
    rank: int
    user: UserSummary
    activated_referrals: int
    task_xp: int
    is_me: bool


class AmbassadorLeaderboard(BaseModel):
    entries: list[AmbassadorLeaderboardEntry]


class CreateAmbassadorTask(_In):
    title: Annotated[str, Field(min_length=1, max_length=80)]
    description: Annotated[str, Field(max_length=1000)] = ""
    xp_reward: Annotated[int, Field(ge=1, le=200)]
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    active: bool = True

    @field_validator("title")
    @classmethod
    def _title(cls, v):
        return _nonempty(_one_line(v))

    @field_validator("description")
    @classmethod
    def _description(cls, v):
        return _clean(v)

    @model_validator(mode="after")
    def _window(self):
        for v in (self.starts_at, self.ends_at):
            if v is not None and v.tzinfo is None:
                raise ValueError("Times need a timezone.")
        if self.ends_at is not None and self.starts_at is not None and self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at.")
        return self


class UpdateAmbassadorTask(_In):
    title: Annotated[str, Field(min_length=1, max_length=80)] | None = None
    description: Annotated[str, Field(max_length=1000)] | None = None
    xp_reward: Annotated[int, Field(ge=1, le=200)] | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    active: bool | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, v):
        return _nonempty(_one_line(v))

    @field_validator("description")
    @classmethod
    def _description(cls, v):
        return _clean(v)

    @model_validator(mode="after")
    def _tz(self):
        for v in (self.starts_at, self.ends_at):
            if v is not None and v.tzinfo is None:
                raise ValueError("Times need a timezone.")
        return self


class AdminSubmission(BaseModel):
    id: uuid.UUID
    task: AmbassadorTaskOut
    user: UserSummary
    status: Literal["submitted", "approved", "rejected"]
    evidence: str
    submitted_at: datetime
    reviewed_at: datetime | None


class AdminSubmissionList(BaseModel):
    items: list[AdminSubmission]


class SubmissionDecision(_In):
    status: Literal["approved", "rejected"]


class SuspendAmbassadorRequest(_In):
    reason: Annotated[str, Field(min_length=1, max_length=500)]

    @field_validator("reason")
    @classmethod
    def _reason(cls, v):
        return _nonempty(_clean(v))


class AmbassadorProfileOut(BaseModel):
    user_id: uuid.UUID
    status: Literal["active", "suspended"]
    approved_at: datetime
    suspended_at: datetime | None
    suspension_reason: str | None


class RewardOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    kind: Literal["referral", "task"]
    ref_id: str
    xp: int
    created_at: datetime
    awarded_at: datetime | None
    reversed_at: datetime | None


class RewardList(BaseModel):
    items: list[RewardOut]


class ReverseRewardRequest(_In):
    reason: Annotated[str, Field(min_length=1, max_length=200)] = "reversed by admin"


class AmbassadorAnalyticsRow(AmbassadorCounts):
    user: UserSummary
    status: Literal["active", "suspended"]


class AmbassadorAnalytics(BaseModel):
    ambassadors: list[AmbassadorAnalyticsRow]
    totals: AmbassadorCounts
