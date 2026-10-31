"""Activity badges: Early Bird, Night Owl, Park Regular.

Revision ID: 0005_activity_badges
Revises: 0004_squirrel_dates
Create Date: 2026-10-01

Catalogue rows only. The rules (services/badges.py) count from tables that already exist:
`activities` (indexed by user and start time) and `zone_visits` (by user and day), so no new table
or counter is needed.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.models import ACTIVITY_BADGES

revision = "0005_activity_badges"
down_revision = "0004_squirrel_dates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    badges = sa.table("badges", sa.column("id", sa.String), sa.column("kind", sa.String),
                      sa.column("title", sa.String), sa.column("description", sa.String))
    op.bulk_insert(badges, ACTIVITY_BADGES)


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM user_badges WHERE badge_id IN ('early_bird', 'night_owl', 'park_regular')"))
    op.execute(sa.text("DELETE FROM badges WHERE id IN ('early_bird', 'night_owl', 'park_regular')"))
