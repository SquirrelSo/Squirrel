"""Squirrel Dates: opt-in, blocks, zone visits, "maybe later".

Revision ID: 0004_squirrel_dates
Revises: 0003_social_challenges
Create Date: 2026-09-29

Why each table exists:
  user_blocks      a member blocks another: never suggested to each other, no follows, no challenges
  dates_prefs      opt-in to Squirrel Dates (no row = off)
  zone_visits      a finished run passed a named campus zone: zone, local day and hour only; kept
                   for opted-in members only, deleted when they opt out
  date_dismissals  "Maybe later" on a suggestion hides that person for a while

Suggestions are advisory: nothing here creates an invitation or a meetup.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.db import UTCDateTime

revision = "0004_squirrel_dates"
down_revision = "0003_social_challenges"
branch_labels = None
depends_on = None


def _user_fk() -> sa.ForeignKey:
    return sa.ForeignKey("users.id", ondelete="CASCADE")


def upgrade() -> None:
    op.create_table(
        "user_blocks",
        sa.Column("blocker_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("blocked_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("blocker_id", "blocked_id", name="pk_user_blocks"),
        sa.CheckConstraint("blocker_id <> blocked_id", name="ck_user_blocks_not_self"),
    )
    op.create_index("ix_user_blocks_blocked", "user_blocks", ["blocked_id"])

    op.create_table(
        "dates_prefs",
        sa.Column("user_id", sa.Uuid(), _user_fk(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
    )
    op.create_index("ix_dates_prefs_enabled", "dates_prefs", ["enabled"])

    op.create_table(
        "zone_visits",
        sa.Column("activity_id", sa.Uuid(), sa.ForeignKey("activities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("zone_id", sa.String(40), nullable=False),
        sa.Column("user_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("visited_on", sa.Date(), nullable=False),
        sa.Column("weekday", sa.SmallInteger(), nullable=False),
        sa.Column("hour", sa.SmallInteger(), nullable=False),
        sa.PrimaryKeyConstraint("activity_id", "zone_id", name="pk_zone_visits"),
        sa.CheckConstraint("weekday BETWEEN 0 AND 6", name="ck_zone_visits_weekday"),
        sa.CheckConstraint("hour BETWEEN 0 AND 23", name="ck_zone_visits_hour"),
    )
    op.create_index("ix_zone_visits_zone_day", "zone_visits", ["zone_id", "visited_on"])
    op.create_index("ix_zone_visits_user_day", "zone_visits", ["user_id", "visited_on"])

    op.create_table(
        "date_dismissals",
        sa.Column("user_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("other_id", sa.Uuid(), _user_fk(), nullable=False),
        sa.Column("dismissed_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "other_id", name="pk_date_dismissals"),
        sa.CheckConstraint("user_id <> other_id", name="ck_date_dismissals_not_self"),
    )


def downgrade() -> None:
    op.drop_table("date_dismissals")
    op.drop_index("ix_zone_visits_user_day", table_name="zone_visits")
    op.drop_index("ix_zone_visits_zone_day", table_name="zone_visits")
    op.drop_table("zone_visits")
    op.drop_index("ix_dates_prefs_enabled", table_name="dates_prefs")
    op.drop_table("dates_prefs")
    op.drop_index("ix_user_blocks_blocked", table_name="user_blocks")
    op.drop_table("user_blocks")
