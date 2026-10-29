"""Rename the head-to-head challenges table to social_challenges.

The Run Module creates its own `challenges` table (and `challenges_pkey`) in the shared database, so
the Social service must not hold that name. 0002 now creates `social_challenges` directly; this
revision renames the table on databases that ran the older 0002, with its primary key, indexes and
constraints. It touches `challenges` only when it is this service's table (it has a
`challenger_id` column, which the Run Module's does not), and does nothing on a fresh database.

Revision ID: 0003_social_challenges
Revises: 0002_community
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_social_challenges"
down_revision = "0002_community"
branch_labels = None
depends_on = None

# Old name → new name, for everything the old 0002 created with the table.
_INDEXES = {
    "ix_challenges_challenger": "ix_social_challenges_challenger",
    "ix_challenges_opponent": "ix_social_challenges_opponent",
}
_CHECKS = {f"ck_challenges_{n}": f"ck_social_challenges_{n}" for n in ("not_self", "metric", "days", "status")}


def _is_old_social_table(bind) -> bool:
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "challenges" not in tables or "social_challenges" in tables:
        return False
    return "challenger_id" in {c["name"] for c in inspector.get_columns("challenges")}


def upgrade() -> None:
    bind = op.get_bind()
    if not _is_old_social_table(bind):
        return
    op.rename_table("challenges", "social_challenges")
    if bind.dialect.name != "postgresql":
        return  # SQLite (tests) keeps index and constraint names inside the table; nothing is shared
    # Index names are schema-wide in PostgreSQL: `challenges_pkey` would still collide. Renaming the
    # primary-key constraint renames its index too.
    op.execute("ALTER TABLE social_challenges RENAME CONSTRAINT challenges_pkey TO social_challenges_pkey")
    for old, new in _INDEXES.items():
        op.execute(f"ALTER INDEX IF EXISTS {old} RENAME TO {new}")
    # Check and foreign-key constraint names are per table, but keep them matching the model.
    for old, new in _CHECKS.items():
        op.execute(f"ALTER TABLE social_challenges RENAME CONSTRAINT {old} TO {new}")
    for column in ("challenger_id", "opponent_id", "winner_id"):
        op.execute(sa.text(f"""
            DO $$ BEGIN
              IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'challenges_{column}_fkey'
                         AND conrelid = 'social_challenges'::regclass) THEN
                ALTER TABLE social_challenges RENAME CONSTRAINT challenges_{column}_fkey TO social_challenges_{column}_fkey;
              END IF;
            END $$;"""))


def downgrade() -> None:
    # 0002 now owns the social_challenges name, so there is nothing to undo: going back to the old
    # name would take `challenges` from the Run Module again.
    pass
