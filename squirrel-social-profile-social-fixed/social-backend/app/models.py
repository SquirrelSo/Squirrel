"""Database model. Normalised: posts reference activities; counters are denormalised onto
`posts` and `user_stats` and only ever changed in the same transaction as the row that
justifies them (a like, a follow, a post), guarded by the unique constraints.

Privacy by construction: no email, no password, no GPS. A run becomes an `activities` row with
distance / duration only; its route and territory geometry stay in the Run Module. The one thing
derived from a route is `zone_visits` (Squirrel Dates): which named campus zone, which day and
hour, kept only for people who opted in and deleted when they opt out.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    Float,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base, UTCDateTime, utcnow


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class User(Base):
    """One row per authenticated account. `id` is the public profile id; `auth_subject` (the
    JWT `sub`) links to the account service and is never returned by the API."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    auth_subject: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    username: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)  # always lowercase
    username_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    display_name: Mapped[str] = mapped_column(String(40), nullable=False)
    bio: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    city_id: Mapped[str | None] = mapped_column(String(32))
    area: Mapped[str | None] = mapped_column(String(60))
    college: Mapped[str | None] = mapped_column(String(80))
    hostel: Mapped[str | None] = mapped_column(String(40))  # one of Settings.hostels
    interests: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    avatar_look: Mapped[dict | None] = mapped_column(JSON)
    avatar_media_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("media.id", ondelete="SET NULL", use_alter=True, name="fk_users_avatar_media"))
    visibility: Mapped[str] = mapped_column(String(16), nullable=False, default="public")
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="user")
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow, onupdate=utcnow)

    stats: Mapped[UserStats] = relationship(back_populates="user", uselist=False, lazy="joined")

    __table_args__ = (
        CheckConstraint("visibility IN ('public', 'private')", name="ck_users_visibility"),
        CheckConstraint("role IN ('user', 'moderator', 'admin')", name="ck_users_role"),
        Index("ix_users_city_created", "city_id", "created_at"),
    )


class UserStats(Base):
    """Hot counters kept apart from the profile row. `xp` is a read-through copy of the Run
    Module's figure (never client-supplied); `xp_synced_at` says how fresh it is."""

    __tablename__ = "user_stats"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    followers_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    following_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    posts_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    xp: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    xp_synced_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    user: Mapped[User] = relationship(back_populates="stats")

    __table_args__ = (
        CheckConstraint("followers_count >= 0 AND following_count >= 0 AND posts_count >= 0", name="ck_user_stats_nonneg"),
    )


class Follow(Base):
    """follower → followee. `pending` = request to a private account (not counted)."""

    __tablename__ = "follows"

    follower_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    followee_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="accepted")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        PrimaryKeyConstraint("follower_id", "followee_id", name="pk_follows"),
        CheckConstraint("follower_id <> followee_id", name="ck_follows_not_self"),
        CheckConstraint("status IN ('accepted', 'pending')", name="ck_follows_status"),
        Index("ix_follows_follower", "follower_id", "status", "created_at"),
        Index("ix_follows_followee", "followee_id", "status", "created_at"),
    )


class Activity(Base):
    """A completed workout, owned by the module that measured it. Social only keeps the summary
    needed to render a post; `source` + `source_ref` point back to the authoritative record
    (e.g. the Run Module's run_id) and are unique so one run can't become two activities."""

    __tablename__ = "activities"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    source: Mapped[str] = mapped_column(String(24), nullable=False)
    source_ref: Mapped[str | None] = mapped_column(String(128))
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    name: Mapped[str | None] = mapped_column(String(60))
    distance_m: Mapped[int | None] = mapped_column(Integer)
    duration_s: Mapped[int | None] = mapped_column(Integer)
    calories: Mapped[int | None] = mapped_column(Integer)
    metrics: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("source", "source_ref", name="uq_activities_source_ref"),
        CheckConstraint("type IN ('run', 'ride', 'workout', 'yoga', 'meal')", name="ck_activities_type"),
        CheckConstraint("source IN ('run_module', 'exercise', 'manual')", name="ck_activities_source"),
        Index("ix_activities_user_started", "user_id", "started_at"),
    )


class Media(Base):
    """An uploaded file in object storage. Created `pending` with a presigned PUT URL, becomes
    `ready` once the server has confirmed the object (size + content type) exists."""

    __tablename__ = "media"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    owner_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    content_type: Mapped[str] = mapped_column(String(64), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        CheckConstraint("purpose IN ('post', 'avatar')", name="ck_media_purpose"),
        CheckConstraint("status IN ('pending', 'ready')", name="ck_media_status"),
        Index("ix_media_owner", "owner_id", "created_at"),
    )


class Post(Base):
    __tablename__ = "posts"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    author_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    caption: Mapped[str] = mapped_column(String(280), nullable=False, default="")
    activity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("activities.id", ondelete="SET NULL"), unique=True)
    media_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("media.id", ondelete="SET NULL"))
    city_id: Mapped[str | None] = mapped_column(String(32))
    area: Mapped[str | None] = mapped_column(String(60))
    backdrop_scene: Mapped[str] = mapped_column(String(24), nullable=False, default="city-sunset")
    backdrop_seed: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    sticker: Mapped[str | None] = mapped_column(String(24))
    crew_name: Mapped[str | None] = mapped_column(String(60))
    likes_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    comments_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        CheckConstraint("likes_count >= 0 AND comments_count >= 0", name="ck_posts_counts_nonneg"),
        Index("ix_posts_created", "created_at", "id"),
        Index("ix_posts_author_created", "author_id", "created_at", "id"),
        Index("ix_posts_city_created", "city_id", "created_at", "id"),
    )


class PostLike(Base):
    __tablename__ = "post_likes"

    post_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        PrimaryKeyConstraint("post_id", "user_id", name="pk_post_likes"),
        Index("ix_post_likes_user", "user_id", "created_at"),
    )


class PostSave(Base):
    __tablename__ = "post_saves"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    post_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        PrimaryKeyConstraint("user_id", "post_id", name="pk_post_saves"),
        Index("ix_post_saves_user_created", "user_id", "created_at", "post_id"),
    )


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    post_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False)
    author_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    body: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (Index("ix_comments_post_created", "post_id", "created_at", "id"),)


class Badge(Base):
    """Badge catalogue. `kind` names the app's badge artwork (BadgeKind)."""

    __tablename__ = "badges"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(60), nullable=False)
    description: Mapped[str] = mapped_column(String(160), nullable=False)


class UserBadge(Base):
    __tablename__ = "user_badges"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    badge_id: Mapped[str] = mapped_column(String(32), ForeignKey("badges.id", ondelete="CASCADE"), nullable=False)
    awarded_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (PrimaryKeyConstraint("user_id", "badge_id", name="pk_user_badges"),)


# Seeded by the initial migration (and by tests via metadata.create_all + seed_badges).
BADGE_CATALOGUE: list[dict[str, str]] = [
    {"id": "first_run", "kind": "first-run", "title": "First Run", "description": "Shared your first verified run."},
    {"id": "first_post", "kind": "social", "title": "Say Hi", "description": "Published your first post."},
    {"id": "streak_7", "kind": "streak", "title": "7-Day Streak", "description": "Logged activity seven days in a row."},
    {"id": "crowd_favourite", "kind": "social", "title": "Crowd Favourite", "description": "A post of yours reached 50 likes."},
]

# Added by migration 0002 (community): the founding members, by the order they verified their email.
FOUNDING_BADGES: list[dict[str, str]] = [
    {"id": "founding_squirrel", "kind": "founding", "title": "Founding Squirrel", "description": "One of the first 15 members."},
    {"id": "founding_500", "kind": "founding", "title": "Founding 500", "description": "One of the first 500 members."},
]

# Added by migration 0005: awarded by the rules in services/badges.py. The ids are the app's (it picks
# the art by id); the descriptions state the default thresholds.
ACTIVITY_BADGES: list[dict[str, str]] = [
    {"id": "early_bird", "kind": "early-bird", "title": "Early Bird", "description": "Started 5 verified activities between 4 and 7 AM."},
    {"id": "night_owl", "kind": "night-owl", "title": "Night Owl", "description": "Started 5 verified activities between 9 PM and 4 AM."},
    {"id": "park_regular", "kind": "park-regular", "title": "Park Regular", "description": "Ran through the same campus spot on 5 different days, with Squirrel Dates on."},
]


# --------------------------------------------------------------------------- community (0002)


class Member(Base):
    """The waitlist entry every account gets on first sight. Everyone is admitted at once; the
    queue position and "invite 3 to skip the line" are shown, not enforced. `verified_rank` orders
    the members whose email was verified at sign-up (the token's `ev` claim) and decides the
    founding badges."""

    __tablename__ = "members"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
    referral_code: Mapped[str] = mapped_column(String(12), unique=True, nullable=False)
    referred_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    referrals_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    verified_rank: Mapped[int | None] = mapped_column(Integer, unique=True)
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    # 0009: the referrer's referrals_count was bumped for this member (exactly once, on claim if
    # already verified, else on verification); and when they first had an activity (ingested by
    # the Run Module / Exercise) within ACTIVATION_WINDOW of joining (services/ambassador.py).
    referral_counted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    activated_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    __table_args__ = (
        CheckConstraint("referrals_count >= 0", name="ck_members_referrals_nonneg"),
        CheckConstraint("referred_by_id IS NULL OR referred_by_id <> user_id", name="ck_members_not_self"),
        Index("ix_members_referred_by", "referred_by_id"),
        Index("ix_members_referred_by_joined", "referred_by_id", "joined_at", "user_id"),
    )


class Crew(Base):
    __tablename__ = "crews"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(40), nullable=False)
    name_key: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)  # lowercased name
    tagline: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    interest: Mapped[str] = mapped_column(String(16), nullable=False)
    meets: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    scope: Mapped[str] = mapped_column(String(8), nullable=False, default="campus")
    hostel: Mapped[str | None] = mapped_column(String(40))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    members_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        CheckConstraint("scope IN ('campus', 'online')", name="ck_crews_scope"),
        CheckConstraint("members_count >= 0", name="ck_crews_members_nonneg"),
        Index("ix_crews_members", "members_count", "created_at"),
    )


class CrewMember(Base):
    __tablename__ = "crew_members"

    crew_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("crews.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(String(8), nullable=False, default="member")
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        PrimaryKeyConstraint("crew_id", "user_id", name="pk_crew_members"),
        CheckConstraint("role IN ('owner', 'member')", name="ck_crew_members_role"),
        Index("ix_crew_members_user", "user_id", "joined_at"),
    )


class CrewVouch(Base):
    """A crew member vouching for another member of the same crew ("I've trained with them")."""

    __tablename__ = "crew_vouches"

    crew_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("crews.id", ondelete="CASCADE"), nullable=False)
    voucher_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    vouchee_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        PrimaryKeyConstraint("crew_id", "voucher_id", "vouchee_id", name="pk_crew_vouches"),
        CheckConstraint("voucher_id <> vouchee_id", name="ck_crew_vouches_not_self"),
        Index("ix_crew_vouches_vouchee", "crew_id", "vouchee_id"),
    )


class Event(Base):
    __tablename__ = "events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    crew_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("crews.id", ondelete="CASCADE"))
    created_by_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    venue: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    online: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    starts_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    ends_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    capacity: Mapped[int | None] = mapped_column(Integer)
    going_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reminder_sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        CheckConstraint("going_count >= 0", name="ck_events_going_nonneg"),
        CheckConstraint("capacity IS NULL OR capacity > 0", name="ck_events_capacity"),
        Index("ix_events_starts", "starts_at", "id"),
        Index("ix_events_crew_starts", "crew_id", "starts_at"),
    )


class EventRsvp(Base):
    __tablename__ = "event_rsvps"

    event_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        PrimaryKeyConstraint("event_id", "user_id", name="pk_event_rsvps"),
        CheckConstraint("status IN ('going', 'interested')", name="ck_event_rsvps_status"),
        Index("ix_event_rsvps_user", "user_id", "created_at"),
    )


class CheckIn(Base):
    """"I'm here": at an event or any meetup spot, optionally telling chosen friends. No GPS."""

    __tablename__ = "checkins"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    event_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("events.id", ondelete="SET NULL"))
    place: Mapped[str] = mapped_column(String(80), nullable=False)
    note: Mapped[str] = mapped_column(String(140), nullable=False, default="")
    notified_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        Index("ix_checkins_user_created", "user_id", "created_at"),
        Index("ix_checkins_event", "event_id", "user_id"),
    )


class Challenge(Base):
    """Head-to-head: who runs more verified km, or finishes more workouts, in `days` days from
    when the opponent accepts. Scores come from `activities`, never from the app."""

    # Not "challenges": that name belongs to the Run Module in the shared database (migration 0003).
    __tablename__ = "social_challenges"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    challenger_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    opponent_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    metric: Mapped[str] = mapped_column(String(12), nullable=False)
    days: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    starts_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    ends_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    challenger_score: Mapped[float | None] = mapped_column(Float)
    opponent_score: Mapped[float | None] = mapped_column(Float)
    winner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    __table_args__ = (
        CheckConstraint("challenger_id <> opponent_id", name="ck_social_challenges_not_self"),
        CheckConstraint("metric IN ('km', 'workouts')", name="ck_social_challenges_metric"),
        CheckConstraint("days BETWEEN 1 AND 30", name="ck_social_challenges_days"),
        CheckConstraint("status IN ('pending', 'accepted', 'declined', 'finished', 'cancelled')", name="ck_social_challenges_status"),
        Index("ix_social_challenges_challenger", "challenger_id", "created_at"),
        Index("ix_social_challenges_opponent", "opponent_id", "created_at"),
    )


class Notification(Base):
    """The in-app notification list; a push is sent alongside when the user has a device token.
    `dedupe_key` (unique per user) makes re-delivered events (the Run Module retries) land once."""

    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    body: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    dedupe_key: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    # 0009: the preference category of `kind` (services/notify.py), and whether a push went out
    # with it (for the per-recipient push rate limit).
    category: Mapped[str | None] = mapped_column(String(16))
    pushed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))

    __table_args__ = (
        UniqueConstraint("user_id", "dedupe_key", name="uq_notifications_dedupe"),
        Index("ix_notifications_user_created", "user_id", "created_at", "id"),
        Index("ix_notifications_user_category_created", "user_id", "category", "created_at"),
    )


class NotificationPreference(Base):
    """Per-user notification settings. No row = everything on, no quiet hours. `categories` maps a
    category (services/notify.py CATEGORIES) to {"push": bool, "in_app": bool}; a missing entry is
    on. `system` is never muted. Quiet hours are minutes of the local day in `timezone`, and may
    wrap midnight (start > end)."""

    __tablename__ = "notification_preferences"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    categories: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    quiet_hours_start: Mapped[int | None] = mapped_column(SmallInteger)
    quiet_hours_end: Mapped[int | None] = mapped_column(SmallInteger)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        CheckConstraint("quiet_hours_start IS NULL OR quiet_hours_start BETWEEN 0 AND 1439", name="ck_notification_prefs_qh_start"),
        CheckConstraint("quiet_hours_end IS NULL OR quiet_hours_end BETWEEN 0 AND 1439", name="ck_notification_prefs_qh_end"),
        CheckConstraint("(quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)", name="ck_notification_prefs_qh_pair"),
    )


class PushToken(Base):
    """An Expo push token of one of the user's devices."""

    __tablename__ = "push_tokens"

    token: Mapped[str] = mapped_column(String(255), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    disabled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    __table_args__ = (
        CheckConstraint("platform IN ('ios', 'android', 'web')", name="ck_push_tokens_platform"),
        Index("ix_push_tokens_user", "user_id"),
    )


class PushTicket(Base):
    """An Expo push ticket waiting for its receipt (services/push.py). Expo only says whether a
    message reached Apple / Google in the receipt, fetched ~15 minutes after the send; the row is
    deleted once its receipt is read, or after a day if Expo never has one."""

    __tablename__ = "push_tickets"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # Expo's ticket id
    token: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (Index("ix_push_tickets_created", "created_at"),)


class AmbassadorApplication(Base):
    """An application to become a Squirrel Ambassador."""

    __tablename__ = "ambassador_applications"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    form_version: Mapped[int] = mapped_column(Integer, nullable=False)
    answers: Mapped[dict] = mapped_column(JSON, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(120), nullable=False)
    submitted_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    message: Mapped[str | None] = mapped_column(String(500))

    __table_args__ = (
        CheckConstraint("status IN ('pending', 'under_review', 'approved', 'rejected', 'suspended')", name="ck_ambassador_status"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_ambassador_idempotency"),
        Index("ix_ambassador_applications_user", "user_id", "submitted_at"),
        Index(
            "uq_ambassador_open",
            "user_id",
            unique=True,
            sqlite_where=text("status IN ('pending', 'under_review', 'approved', 'suspended')"),
            postgresql_where=text("status IN ('pending', 'under_review', 'approved', 'suspended')"),
        ),
    )


class AmbassadorProfile(Base):
    """An ambassador: made when their application is approved. Their referral code is their
    members.referral_code (one code system). Suspended ambassadors earn no rewards."""

    __tablename__ = "ambassador_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    application_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("ambassador_applications.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    approved_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    suspended_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    suspension_reason: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        CheckConstraint("status IN ('active', 'suspended')", name="ck_ambassador_profiles_status"),
        Index("ix_ambassador_profiles_status", "status"),
    )


class AmbassadorTask(Base):
    __tablename__ = "ambassador_tasks"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    xp_reward: Mapped[int] = mapped_column(Integer, nullable=False)
    starts_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    ends_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        CheckConstraint("xp_reward BETWEEN 1 AND 200", name="ck_ambassador_tasks_xp"),
        CheckConstraint("ends_at IS NULL OR ends_at > starts_at", name="ck_ambassador_tasks_window"),
        Index("ix_ambassador_tasks_active", "active", "starts_at"),
    )


class AmbassadorTaskSubmission(Base):
    __tablename__ = "ambassador_task_submissions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    task_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("ambassador_tasks.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="submitted")
    evidence: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    submitted_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    reviewer_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))

    __table_args__ = (
        UniqueConstraint("task_id", "user_id", name="uq_ambassador_submissions_task_user"),
        CheckConstraint("status IN ('submitted', 'approved', 'rejected')", name="ck_ambassador_submissions_status"),
        Index("ix_ambassador_submissions_status", "status", "submitted_at"),
        Index("ix_ambassador_submissions_user", "user_id", "submitted_at"),
    )


class AmbassadorReward(Base):
    """XP owed to an ambassador. The Run Module keeps the ledger: a row is awarded there (awarded_at)
    after the commit that made it, retried while it isn't; `idempotency_key` is the Run Module's
    too (referral:{referredUserId} / task:{taskId}:{userId}), so a retry never awards twice. A
    reversed row counts nothing; its reversal is sent likewise (reverse_synced_at)."""

    __tablename__ = "ambassador_rewards"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    ref_id: Mapped[str] = mapped_column(String(80), nullable=False)
    xp: Mapped[int] = mapped_column(Integer, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    awarded_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    reversal_reason: Mapped[str | None] = mapped_column(String(200))
    reverse_synced_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    __table_args__ = (
        CheckConstraint("kind IN ('referral', 'task')", name="ck_ambassador_rewards_kind"),
        CheckConstraint("xp > 0", name="ck_ambassador_rewards_xp"),
        Index("ix_ambassador_rewards_user_kind_created", "user_id", "kind", "created_at"),
    )


# --------------------------------------------------------------------------- Squirrel Dates (0004)


class UserBlock(Base):
    """`blocker` never sees `blocked` suggested again, and neither can follow or challenge the other.
    One row, one direction; every check reads both directions."""

    __tablename__ = "user_blocks"

    blocker_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    blocked_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        PrimaryKeyConstraint("blocker_id", "blocked_id", name="pk_user_blocks"),
        CheckConstraint("blocker_id <> blocked_id", name="ck_user_blocks_not_self"),
        Index("ix_user_blocks_blocked", "blocked_id"),
    )


class DatesPref(Base):
    """Opt-in to Squirrel Dates. No row = off: nobody is suggested, or suggested to, by default."""

    __tablename__ = "dates_prefs"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (Index("ix_dates_prefs_enabled", "enabled"),)


class ZoneVisit(Base):
    """A finished run passed through a named campus zone: the zone, the local day and hour, nothing
    else (no points, no route, no minute). One row per run and zone, so a re-sent run counts once."""

    __tablename__ = "zone_visits"

    activity_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("activities.id", ondelete="CASCADE"), nullable=False)
    zone_id: Mapped[str] = mapped_column(String(40), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    visited_on: Mapped[date] = mapped_column(Date, nullable=False)
    weekday: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # 0 = Monday, campus time
    hour: Mapped[int] = mapped_column(SmallInteger, nullable=False)     # 0–23, campus time

    __table_args__ = (
        PrimaryKeyConstraint("activity_id", "zone_id", name="pk_zone_visits"),
        CheckConstraint("weekday BETWEEN 0 AND 6", name="ck_zone_visits_weekday"),
        CheckConstraint("hour BETWEEN 0 AND 23", name="ck_zone_visits_hour"),
        Index("ix_zone_visits_zone_day", "zone_id", "visited_on"),
        Index("ix_zone_visits_user_day", "user_id", "visited_on"),
    )


class DateDismissal(Base):
    """"Maybe later" on a Squirrel Dates suggestion: that person isn't suggested again for a while."""

    __tablename__ = "date_dismissals"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    other_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    dismissed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    __table_args__ = (
        PrimaryKeyConstraint("user_id", "other_id", name="pk_date_dismissals"),
        CheckConstraint("user_id <> other_id", name="ck_date_dismissals_not_self"),
    )
