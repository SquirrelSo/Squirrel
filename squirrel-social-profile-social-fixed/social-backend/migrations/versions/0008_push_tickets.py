"""Expo push tickets awaiting their receipts.

Revision ID: 0008_push_tickets
Revises: 0007_ambassador
Create Date: 2026-10-03

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.db import UTCDateTime

revision = "0008_push_tickets"
down_revision = "0007_ambassador"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "push_tickets",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("token", sa.String(255), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
    )
    op.create_index("ix_push_tickets_created", "push_tickets", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_push_tickets_created", table_name="push_tickets")
    op.drop_table("push_tickets")
