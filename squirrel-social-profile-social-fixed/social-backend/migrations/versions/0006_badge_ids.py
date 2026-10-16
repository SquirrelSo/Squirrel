"""Badge ids in the app's form (underscores), and the activity badges' new wording.

Revision ID: 0006_badge_ids
Revises: 0005_activity_badges
Create Date: 2026-10-02

The app names badges `founding_squirrel`, `early_bird`…; Social's first badges were `founding-squirrel`,
`first-run`…, so the app couldn't match them. Each old row is copied under its new id, awards and
notification keys move to it, and the old row goes. A database built after this change already has
the new ids (the catalogue constants seed them), so every step is a no-op there.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.models import ACTIVITY_BADGES

revision = "0006_badge_ids"
down_revision = "0005_activity_badges"
branch_labels = None
depends_on = None

RENAMED = {
    "first-run": "first_run", "first-post": "first_post", "streak-7": "streak_7",
    "crowd-favourite": "crowd_favourite", "founding-squirrel": "founding_squirrel", "founding-500": "founding_500",
}


def _rename(old: str, new: str) -> None:
    bind = op.get_bind()
    if bind.execute(sa.text("SELECT 1 FROM badges WHERE id = :old"), {"old": old}).first() is None:
        return
    if bind.execute(sa.text("SELECT 1 FROM badges WHERE id = :new"), {"new": new}).first() is None:
        bind.execute(sa.text("INSERT INTO badges (id, kind, title, description) "
                             "SELECT :new, kind, title, description FROM badges WHERE id = :old"), {"old": old, "new": new})
    bind.execute(sa.text("UPDATE user_badges SET badge_id = :new WHERE badge_id = :old"), {"old": old, "new": new})
    bind.execute(sa.text("UPDATE notifications SET dedupe_key = :new_key WHERE dedupe_key = :old_key"),
                 {"old_key": f"badge:{old}", "new_key": f"badge:{new}"})
    bind.execute(sa.text("DELETE FROM badges WHERE id = :old"), {"old": old})


def upgrade() -> None:
    for old, new in RENAMED.items():
        _rename(old, new)
    for badge in ACTIVITY_BADGES:
        op.execute(sa.text("UPDATE badges SET description = :d WHERE id = :id").bindparams(d=badge["description"], id=badge["id"]))


def downgrade() -> None:
    for old, new in RENAMED.items():
        _rename(new, old)
