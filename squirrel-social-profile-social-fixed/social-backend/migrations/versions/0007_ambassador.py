"""Ambassador applications.

Revision ID: 0007_ambassador
Revises: 0006_badge_ids
Create Date: 2026-10-02

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.db import UTCDateTime

revision = "0007_ambassador"
down_revision = "0006_badge_ids"
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table(
        "ambassador_applications",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("form_version", sa.Integer(), nullable=False),
        sa.Column("answers", sa.JSON(), nullable=False),
        sa.Column("idempotency_key", sa.String(120), nullable=False),
        sa.Column("submitted_at", UTCDateTime(), nullable=False),
        sa.Column("decided_at", UTCDateTime()),
        sa.Column("message", sa.String(500)),
        sa.CheckConstraint("status IN ('pending', 'under_review', 'approved', 'rejected')", name="ck_ambassador_status"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_ambassador_idempotency"),
    )
    
    op.create_index(
        "ix_ambassador_applications_user", 
        "ambassador_applications", 
        ["user_id", "submitted_at"]
    )
    
    op.create_index(
        "uq_ambassador_open",
        "ambassador_applications",
        ["user_id"],
        unique=True,
        sqlite_where=sa.text("status IN ('pending', 'under_review', 'approved')"),
        postgresql_where=sa.text("status IN ('pending', 'under_review', 'approved')")
    )


def downgrade() -> None:
    op.drop_table("ambassador_applications")
