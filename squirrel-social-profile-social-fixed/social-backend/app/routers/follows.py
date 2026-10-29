"""Follow graph.

Idempotent by design: following twice returns the same state, unfollowing someone you don't
follow is a no-op. The (follower, followee) primary key and a CHECK against self-follows are
the real guards; counters move only when a row was actually inserted/deleted/accepted.
Following a private account creates a pending request that doesn't count until accepted.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter
from sqlalchemy import delete, select, update

from app.db import utcnow
from app.deps import DB, AppSettings, CurrentViewer, Limiter, Storage
from app.errors import forbidden, invalid, not_found
from app.models import Follow, User, UserStats
from app.pagination import before, clamp_limit, decode_uuid_cursor, encode_cursor
from app.schemas import FollowResult, FollowStatus, UserPage
from app.services import social
from app.services.dates import is_blocked
from app.services.social import bump, insert_ignore

router = APIRouter(prefix="/v1", tags=["follows"])


def _result(db, viewer_id: uuid.UUID, target_id: uuid.UUID) -> FollowResult:
    st = social.follow_status(db, viewer_id, target_id)
    counts = db.execute(select(UserStats.followers_count, UserStats.following_count).where(UserStats.user_id == target_id)).one()
    return FollowResult(**st.model_dump(), followers=counts[0], following_count=counts[1])


def _unfollow(db, follower_id: uuid.UUID, followee_id: uuid.UUID, only_status: str | None = None) -> None:
    status = db.scalar(select(Follow.status).where(Follow.follower_id == follower_id, Follow.followee_id == followee_id))
    if status is None or (only_status and status != only_status):
        return
    res = db.execute(delete(Follow).where(Follow.follower_id == follower_id, Follow.followee_id == followee_id, Follow.status == status))
    if res.rowcount == 1 and status == "accepted":
        bump(db, UserStats, UserStats.user_id == follower_id, following_count=-1)
        bump(db, UserStats, UserStats.user_id == followee_id, followers_count=-1)


@router.post("/users/{user_id}/follow", response_model=FollowResult)
def follow(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    if user_id == viewer.id:
        raise invalid("You can't follow yourself.", "self_follow")
    target = social.get_user_or_404(db, user_id)
    if is_blocked(db, viewer.id, target.id):
        raise not_found("User not found.")
    limiter.hit("follow", str(viewer.id))
    status = "pending" if target.visibility == "private" else "accepted"
    inserted = insert_ignore(db, Follow, {"follower_id": viewer.id, "followee_id": target.id, "status": status, "created_at": utcnow()})
    if inserted and status == "accepted":
        bump(db, UserStats, UserStats.user_id == viewer.id, following_count=1)
        bump(db, UserStats, UserStats.user_id == target.id, followers_count=1)
    db.commit()
    return _result(db, viewer.id, target.id)


@router.delete("/users/{user_id}/follow", response_model=FollowResult)
def unfollow(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    if user_id == viewer.id:
        raise invalid("You can't unfollow yourself.", "self_follow")
    social.get_user_or_404(db, user_id)
    limiter.hit("follow", str(viewer.id))
    _unfollow(db, viewer.id, user_id)
    db.commit()
    return _result(db, viewer.id, user_id)


@router.get("/users/{user_id}/follow-status", response_model=FollowStatus)
def get_follow_status(user_id: uuid.UUID, db: DB, viewer: CurrentViewer):
    social.get_user_or_404(db, user_id)
    if user_id == viewer.id:
        return FollowStatus(following=False, followed_by=False)
    return social.follow_status(db, viewer.id, user_id)


def _list(db, viewer, settings, storage, *, user_id: uuid.UUID, direction: str, status: str, cursor: str | None, limit: int) -> UserPage:
    """direction='followers' → people following user_id; 'following' → people user_id follows."""
    n = clamp_limit(limit)
    if direction == "followers":
        other, anchor = Follow.follower_id, Follow.followee_id
    else:
        other, anchor = Follow.followee_id, Follow.follower_id
    stmt = (
        select(User, UserStats.xp, Follow.created_at)
        .join(Follow, other == User.id)
        .join(UserStats, UserStats.user_id == User.id)
        .where(anchor == user_id, Follow.status == status)
    )
    if cursor:
        ts, key = decode_uuid_cursor(cursor)
        stmt = stmt.where(before(Follow.created_at, other, ts, key))
    rows = db.execute(stmt.order_by(Follow.created_at.desc(), other.desc()).limit(n + 1)).all()
    page = rows[:n]
    nxt = encode_cursor(page[-1][2], page[-1][0].id) if len(rows) > n else None
    return UserPage(items=social.serialize_user_rows(db, viewer.id, page, settings, storage), next_cursor=nxt)


@router.get("/users/me/follow-requests", response_model=UserPage)
def follow_requests(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, cursor: str | None = None, limit: int = 20):
    return _list(db, viewer, settings, storage, user_id=viewer.id, direction="followers", status="pending", cursor=cursor, limit=limit)


@router.post("/users/me/follow-requests/{user_id}", response_model=FollowStatus)
def accept_follow_request(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    limiter.hit("follow", str(viewer.id))
    res = db.execute(
        update(Follow).where(Follow.follower_id == user_id, Follow.followee_id == viewer.id, Follow.status == "pending").values(status="accepted")
    )
    if res.rowcount != 1:
        already = db.scalar(select(Follow.status).where(Follow.follower_id == user_id, Follow.followee_id == viewer.id))
        if already != "accepted":
            raise not_found("No pending request from that user.")
    else:
        bump(db, UserStats, UserStats.user_id == user_id, following_count=1)
        bump(db, UserStats, UserStats.user_id == viewer.id, followers_count=1)
    db.commit()
    return social.follow_status(db, viewer.id, user_id)


@router.delete("/users/me/follow-requests/{user_id}", response_model=FollowStatus)
def decline_follow_request(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    limiter.hit("follow", str(viewer.id))
    _unfollow(db, user_id, viewer.id, only_status="pending")
    db.commit()
    return social.follow_status(db, viewer.id, user_id)


@router.get("/users/{user_id}/followers", response_model=UserPage)
def followers(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, cursor: str | None = None, limit: int = 20):
    user = social.get_user_or_404(db, user_id)
    if not social.can_see_content(db, viewer.id, user):
        raise forbidden("This account is private.")
    return _list(db, viewer, settings, storage, user_id=user.id, direction="followers", status="accepted", cursor=cursor, limit=limit)


@router.get("/users/{user_id}/following", response_model=UserPage)
def following(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, cursor: str | None = None, limit: int = 20):
    user = social.get_user_or_404(db, user_id)
    if not social.can_see_content(db, viewer.id, user):
        raise forbidden("This account is private.")
    return _list(db, viewer, settings, storage, user_id=user.id, direction="following", status="accepted", cursor=cursor, limit=limit)
