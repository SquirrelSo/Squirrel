"""Notification preferences and push accounting; the ambassador programme.

Revision ID: 0009_notifications_ambassadors
Revises: 0008_push_tickets
Create Date: 2026-10-07

* notification_preferences (one row per user who changed something), notifications.category and
  .pushed (the per-recipient push rate limit counts pushes per category).
* ambassador_profiles / _tasks / _task_submissions / _rewards. Every application already approved
  gets its profile here, so approval stays the only way in.
* ambassador_applications.status may be 'suspended' (and a suspended one still blocks reapplying).
* members.referral_counted (a referral counts for the referrer exactly once, including when the
  friend verifies their email after claiming the code) and members.activated_at. Existing referrals
  of verified members were counted when claimed, so they are marked counted.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.db import UTCDateTime

revision = "0009_notifications_ambassadors"
down_revision = "0008_push_tickets"
branch_labels = None
depends_on = None

OLD_STATUSES = "status IN ('pending', 'under_review', 'approved', 'rejected')"
NEW_STATUSES = "status IN ('pending', 'under_review', 'approved', 'rejected', 'suspended')"
OLD_OPEN = "status IN ('pending', 'under_review', 'approved')"
NEW_OPEN = "status IN ('pending', 'under_review', 'approved', 'suspended')"


def _application_statuses(check: str, open_where: str) -> None:
    op.drop_index("uq_ambassador_open", table_name="ambassador_applications")
    with op.batch_alter_table("ambassador_applications") as batch:
        batch.drop_constraint("ck_ambassador_status", type_="check")
        batch.create_check_constraint("ck_ambassador_status", check)
    op.create_index("uq_ambassador_open", "ambassador_applications", ["user_id"], unique=True,
                    sqlite_where=sa.text(open_where), postgresql_where=sa.text(open_where))


def upgrade() -> None:
    # --- notifications
    op.create_table(
        "notification_preferences",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("categories", sa.JSON(), nullable=False),
        sa.Column("quiet_hours_start", sa.SmallInteger()),
        sa.Column("quiet_hours_end", sa.SmallInteger()),
        sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
        sa.CheckConstraint("quiet_hours_start IS NULL OR quiet_hours_start BETWEEN 0 AND 1439", name="ck_notification_prefs_qh_start"),
        sa.CheckConstraint("quiet_hours_end IS NULL OR quiet_hours_end BETWEEN 0 AND 1439", name="ck_notification_prefs_qh_end"),
        sa.CheckConstraint("(quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)", name="ck_notification_prefs_qh_pair"),
    )
    with op.batch_alter_table("notifications") as batch:
        batch.add_column(sa.Column("category", sa.String(16)))
        batch.add_column(sa.Column("pushed", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index("ix_notifications_user_category_created", "notifications", ["user_id", "category", "created_at"])

    # --- members: referral counted once, activation
    with op.batch_alter_table("members") as batch:
        batch.add_column(sa.Column("referral_counted", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("activated_at", UTCDateTime()))
    op.execute("UPDATE members SET referral_counted = true WHERE referred_by_id IS NOT NULL AND email_verified = true")
    op.create_index("ix_members_referred_by_joined", "members", ["referred_by_id", "joined_at", "user_id"])

    # --- ambassadors
    _application_statuses(NEW_STATUSES, NEW_OPEN)
    op.create_table(
        "ambassador_profiles",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("application_id", sa.Uuid(), sa.ForeignKey("ambassador_applications.id", ondelete="SET NULL")),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("approved_at", UTCDateTime(), nullable=False),
        sa.Column("suspended_at", UTCDateTime()),
        sa.Column("suspension_reason", sa.String(500)),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.CheckConstraint("status IN ('active', 'suspended')", name="ck_ambassador_profiles_status"),
    )
    op.create_index("ix_ambassador_profiles_status", "ambassador_profiles", ["status"])
    op.execute(
        "INSERT INTO ambassador_profiles (user_id, application_id, status, approved_at, created_at) "
        "SELECT user_id, id, 'active', COALESCE(decided_at, submitted_at), COALESCE(decided_at, submitted_at) "
        "FROM ambassador_applications WHERE status = 'approved'"
    )
    op.create_table(
        "ambassador_tasks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("title", sa.String(80), nullable=False),
        sa.Column("description", sa.String(1000), nullable=False),
        sa.Column("xp_reward", sa.Integer(), nullable=False),
        sa.Column("starts_at", UTCDateTime(), nullable=False),
        sa.Column("ends_at", UTCDateTime()),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.CheckConstraint("xp_reward BETWEEN 1 AND 200", name="ck_ambassador_tasks_xp"),
        sa.CheckConstraint("ends_at IS NULL OR ends_at > starts_at", name="ck_ambassador_tasks_window"),
    )
    op.create_index("ix_ambassador_tasks_active", "ambassador_tasks", ["active", "starts_at"])
    op.create_table(
        "ambassador_task_submissions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("ambassador_tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("evidence", sa.String(1000), nullable=False),
        sa.Column("submitted_at", UTCDateTime(), nullable=False),
        sa.Column("reviewed_at", UTCDateTime()),
        sa.Column("reviewer_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.UniqueConstraint("task_id", "user_id", name="uq_ambassador_submissions_task_user"),
        sa.CheckConstraint("status IN ('submitted', 'approved', 'rejected')", name="ck_ambassador_submissions_status"),
    )
    op.create_index("ix_ambassador_submissions_status", "ambassador_task_submissions", ["status", "submitted_at"])
    op.create_index("ix_ambassador_submissions_user", "ambassador_task_submissions", ["user_id", "submitted_at"])
    op.create_table(
        "ambassador_rewards",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("ref_id", sa.String(80), nullable=False),
        sa.Column("xp", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.String(200), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.Column("awarded_at", UTCDateTime()),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reversed_at", UTCDateTime()),
        sa.Column("reversal_reason", sa.String(200)),
        sa.Column("reverse_synced_at", UTCDateTime()),
        sa.UniqueConstraint("idempotency_key", name="uq_ambassador_rewards_idempotency"),
        sa.CheckConstraint("kind IN ('referral', 'task')", name="ck_ambassador_rewards_kind"),
        sa.CheckConstraint("xp > 0", name="ck_ambassador_rewards_xp"),
    )
    op.create_index("ix_ambassador_rewards_user_kind_created", "ambassador_rewards", ["user_id", "kind", "created_at"])


def downgrade() -> None:
    op.drop_table("ambassador_rewards")
    op.drop_table("ambassador_task_submissions")
    op.drop_table("ambassador_tasks")
    op.drop_table("ambassador_profiles")
    op.execute("UPDATE ambassador_applications SET status = 'approved' WHERE status = 'suspended'")
    _application_statuses(OLD_STATUSES, OLD_OPEN)
    op.drop_index("ix_members_referred_by_joined", table_name="members")
    with op.batch_alter_table("members") as batch:
        batch.drop_column("activated_at")
        batch.drop_column("referral_counted")
    op.drop_index("ix_notifications_user_category_created", table_name="notifications")
    with op.batch_alter_table("notifications") as batch:
        batch.drop_column("pushed")
        batch.drop_column("category")
    op.drop_table("notification_preferences")
