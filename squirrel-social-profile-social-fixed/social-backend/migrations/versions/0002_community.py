"""Community: waitlist and referrals, hostels, crews, events, check-ins, challenges, notifications.

Revision ID: 0002_community
Revises: 0001_profile_social
Create Date: 2026-09-29

Why each table exists:
  members         the waitlist entry of every account: queue position, referral code, who
                  referred it, and the verified-email order that decides the founding badges
  users.hostel    the member's hostel (one of SOCIAL_HOSTELS), for hostel vs hostel
  crews / crew_members / crew_vouches   crews, who is in them since when, and who vouches for whom
  events / event_rsvps                  meetups (of a crew or open to all) and who is going
  checkins        "I'm here" at an event or a meetup spot, optionally telling friends; no GPS
  social_challenges  head-to-head: most verified km or most workouts in N days (named
                     social_challenges since 0003: the Run Module owns `challenges` in the
                     shared database; databases that ran the older 0002 are renamed by 0003)
  notifications   the in-app list (a push goes out alongside); dedupe_key absorbs retries
  push_tokens     the Expo push tokens of each user's devices
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.db import UTCDateTime
from app.models import FOUNDING_BADGES

revision = "0002_community"
down_revision = "0001_profile_social"
branch_labels = None
depends_on = None


def _user_fk(**kw) -> sa.ForeignKey:
    return sa.ForeignKey("users.id", ondelete=kw.get("ondelete", "CASCADE"))


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("hostel", sa.String(40)))

    op.create_table(
        "members",
        sa.Column("user_id", sa.Uuid(), _user_fk(), primary_key=True),
        sa.Column("position", sa.Integer(), nullable=False, unique=True),
        sa.Column("referral_code", sa.String(12), nullable=False, unique=True),
        sa.Column("referred_by_id", sa.Uuid(), _user_fk(ondelete="SET NULL")),
        sa.Column("referrals_count", sa.Integer(), nullable=False),
        sa.Column("email_verified", sa.Boolean(), nullable=False),
        sa.Column("verified_rank", sa.Integer(), unique=True),
        sa.Column("joined_at", UTCDateTime(), nullable=False),
        sa.CheckConstraint("referrals_count >= 0", name="ck_members_referrals_nonneg"),
        sa.CheckConstraint("referred_by_id IS NULL OR referred_by_id <> user_id", name="ck_members_not_self"),
    )
    op.create_index("ix_members_referred_by", "members", ["referred_by_id"])

    op.create_table(
        "crews",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("name_key", sa.String(40), nullable=False, unique=True),
        sa.Column("tagline", sa.String(120), nullable=False),
        sa.Column("interest", sa.String(16), nullable=False),
        sa.Column("meets", sa.String(60), nullable=False),
        sa.Column("scope", sa.String(8), nullable=False),
        sa.Column("hostel", sa.String(40)),
        sa.Column("created_by_id", sa.Uuid(), _user_fk(ondelete="SET NULL")),
        sa.Column("members_count", sa.Integer(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.CheckConstraint("scope IN ('campus', 'online')", name="ck_crews_scope"),
        sa.CheckConstraint("members_count >= 0", name="ck_crews_members_nonneg"),
    )
    op.create_index("ix_crews_members", "crews", ["members_count", "created_at"])

    op.create_table(
        "crew_members",
        sa.Column("crew_id", sa.Uuid(), sa.ForeignKey("crews.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("role", sa.String(8), nullable=False),
        sa.Column("joined_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("crew_id", "user_id", name="pk_crew_members"),
        sa.CheckConstraint("role IN ('owner', 'member')", name="ck_crew_members_role"),
    )
    op.create_index("ix_crew_members_user", "crew_members", ["user_id", "joined_at"])

    op.create_table(
        "crew_vouches",
        sa.Column("crew_id", sa.Uuid(), sa.ForeignKey("crews.id", ondelete="CASCADE"), nullable=False),
        sa.Column("voucher_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("vouchee_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("crew_id", "voucher_id", "vouchee_id", name="pk_crew_vouches"),
        sa.CheckConstraint("voucher_id <> vouchee_id", name="ck_crew_vouches_not_self"),
    )
    op.create_index("ix_crew_vouches_vouchee", "crew_vouches", ["crew_id", "vouchee_id"])

    op.create_table(
        "events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("crew_id", sa.Uuid(), sa.ForeignKey("crews.id", ondelete="CASCADE")),
        sa.Column("created_by_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("title", sa.String(80), nullable=False),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("venue", sa.String(80), nullable=False),
        sa.Column("online", sa.Boolean(), nullable=False),
        sa.Column("starts_at", UTCDateTime(), nullable=False),
        sa.Column("ends_at", UTCDateTime()),
        sa.Column("capacity", sa.Integer()),
        sa.Column("going_count", sa.Integer(), nullable=False),
        sa.Column("reminder_sent_at", UTCDateTime()),
        sa.Column("cancelled_at", UTCDateTime()),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.CheckConstraint("going_count >= 0", name="ck_events_going_nonneg"),
        sa.CheckConstraint("capacity IS NULL OR capacity > 0", name="ck_events_capacity"),
    )
    op.create_index("ix_events_starts", "events", ["starts_at", "id"])
    op.create_index("ix_events_crew_starts", "events", ["crew_id", "starts_at"])

    op.create_table(
        "event_rsvps",
        sa.Column("event_id", sa.Uuid(), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("event_id", "user_id", name="pk_event_rsvps"),
        sa.CheckConstraint("status IN ('going', 'interested')", name="ck_event_rsvps_status"),
    )
    op.create_index("ix_event_rsvps_user", "event_rsvps", ["user_id", "created_at"])

    op.create_table(
        "checkins",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("event_id", sa.Uuid(), sa.ForeignKey("events.id", ondelete="SET NULL")),
        sa.Column("place", sa.String(80), nullable=False),
        sa.Column("note", sa.String(140), nullable=False),
        sa.Column("notified_count", sa.Integer(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
    )
    op.create_index("ix_checkins_user_created", "checkins", ["user_id", "created_at"])
    op.create_index("ix_checkins_event", "checkins", ["event_id", "user_id"])

    op.create_table(
        "social_challenges",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("challenger_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("opponent_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("metric", sa.String(12), nullable=False),
        sa.Column("days", sa.SmallInteger(), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("starts_at", UTCDateTime()),
        sa.Column("ends_at", UTCDateTime()),
        sa.Column("challenger_score", sa.Float()),
        sa.Column("opponent_score", sa.Float()),
        sa.Column("winner_id", sa.Uuid(), _user_fk(ondelete="SET NULL")),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.Column("finished_at", UTCDateTime()),
        sa.CheckConstraint("challenger_id <> opponent_id", name="ck_social_challenges_not_self"),
        sa.CheckConstraint("metric IN ('km', 'workouts')", name="ck_social_challenges_metric"),
        sa.CheckConstraint("days BETWEEN 1 AND 30", name="ck_social_challenges_days"),
        sa.CheckConstraint("status IN ('pending', 'accepted', 'declined', 'finished', 'cancelled')", name="ck_social_challenges_status"),
    )
    op.create_index("ix_social_challenges_challenger", "social_challenges", ["challenger_id", "created_at"])
    op.create_index("ix_social_challenges_opponent", "social_challenges", ["opponent_id", "created_at"])

    op.create_table(
        "notifications",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("body", sa.String(240), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), _user_fk(ondelete="SET NULL")),
        sa.Column("dedupe_key", sa.String(120)),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.Column("read_at", UTCDateTime()),
        sa.UniqueConstraint("user_id", "dedupe_key", name="uq_notifications_dedupe"),
    )
    op.create_index("ix_notifications_user_created", "notifications", ["user_id", "created_at", "id"])

    op.create_table(
        "push_tokens",
        sa.Column("token", sa.String(255), primary_key=True),
        sa.Column("user_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.Column("last_seen_at", UTCDateTime(), nullable=False),
        sa.Column("disabled_at", UTCDateTime()),
        sa.CheckConstraint("platform IN ('ios', 'android', 'web')", name="ck_push_tokens_platform"),
    )
    op.create_index("ix_push_tokens_user", "push_tokens", ["user_id"])

    badges = sa.table("badges", sa.column("id", sa.String), sa.column("kind", sa.String),
                      sa.column("title", sa.String), sa.column("description", sa.String))
    op.bulk_insert(badges, FOUNDING_BADGES)


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM user_badges WHERE badge_id IN ('founding-squirrel', 'founding-500')"))
    op.execute(sa.text("DELETE FROM badges WHERE id IN ('founding-squirrel', 'founding-500')"))
    for table in ("push_tokens", "notifications", "social_challenges", "checkins", "event_rsvps", "events",
                  "crew_vouches", "crew_members", "crews", "members"):
        op.drop_table(table)
    with op.batch_alter_table("users") as batch:
        batch.drop_column("hostel")
