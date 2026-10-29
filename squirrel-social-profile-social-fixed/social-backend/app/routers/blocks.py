"""Blocking another member.

  POST   /v1/users/{id}/block     block: follows both ways are removed
  DELETE /v1/users/{id}/block     unblock
  GET    /v1/users/{id}/block     { user_id, blocked }: whether I blocked them
  GET    /v1/users/me/blocks      the people I blocked

A block works in both directions whoever made it: the two are never suggested to each other by
Squirrel Dates, and neither can follow or challenge the other. Being blocked is never shown to the
person blocked (their follow or challenge just finds no such user).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter
from sqlalchemy import delete, select

from app.db import utcnow
from app.deps import DB, AppSettings, CurrentViewer, Limiter, Storage
from app.errors import invalid
from app.models import UserBlock
from app.routers.follows import _unfollow
from app.schemas_community import BlockList, BlockResult
from app.services import community, social
from app.services.social import insert_ignore

router = APIRouter(prefix="/v1", tags=["blocks"])


def _blocked_by_me(db, me: uuid.UUID, other: uuid.UUID) -> bool:
    return db.get(UserBlock, (me, other)) is not None


@router.get("/users/me/blocks", response_model=BlockList)
def my_blocks(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    ids = db.scalars(select(UserBlock.blocked_id).where(UserBlock.blocker_id == viewer.id)
                     .order_by(UserBlock.created_at.desc()).limit(500)).all()
    people = community.summaries(db, ids, settings, storage)
    return BlockList(items=[people[i] for i in ids if i in people])


@router.get("/users/{user_id}/block", response_model=BlockResult)
def block_status(user_id: uuid.UUID, db: DB, viewer: CurrentViewer):
    return BlockResult(user_id=user_id, blocked=_blocked_by_me(db, viewer.id, user_id))


@router.post("/users/{user_id}/block", response_model=BlockResult)
def block(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    if user_id == viewer.id:
        raise invalid("You can't block yourself.", "self_block")
    social.get_user_or_404(db, user_id)
    limiter.hit("block", str(viewer.id))
    insert_ignore(db, UserBlock, {"blocker_id": viewer.id, "blocked_id": user_id, "created_at": utcnow()})
    _unfollow(db, viewer.id, user_id)
    _unfollow(db, user_id, viewer.id)
    db.commit()
    return BlockResult(user_id=user_id, blocked=True)


@router.delete("/users/{user_id}/block", response_model=BlockResult)
def unblock(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    limiter.hit("block", str(viewer.id))
    db.execute(delete(UserBlock).where(UserBlock.blocker_id == viewer.id, UserBlock.blocked_id == user_id))
    db.commit()
    return BlockResult(user_id=user_id, blocked=False)
