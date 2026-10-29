"""Posts, likes, saves and comments.

Nothing that counts is taken from the client: author comes from the token, counters from the
database, and activity numbers from the module that measured them (Run Module for runs).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.auth import Viewer
from app.db import utcnow
from app.deps import DB, AppSettings, CurrentViewer, Limiter, RunModuleDep, Storage
from app.errors import ApiError, conflict, forbidden, invalid, not_found
from app.models import Activity, Comment, Media, Post, PostLike, PostSave, User, UserStats
from app.pagination import after, clamp_limit, decode_uuid_cursor, encode_cursor
from app.schemas import (
    CommentOut,
    CommentPage,
    CreateCommentRequest,
    CreatePostRequest,
    ExistingActivityRef,
    LikeResult,
    ManualActivity,
    PostOut,
    RunActivityRef,
    SaveResult,
)
from app.services import badges, social, xp_cache
from app.services.run_module import RunModule, RunModuleError
from app.services.social import bump, insert_ignore

router = APIRouter(prefix="/v1", tags=["posts"])

MODERATOR_ROLES = ("moderator", "admin")
CROWD_FAVOURITE_LIKES = 50
SHAREABLE_RUN_STATUSES = ("finalized", "flagged")


# --------------------------------------------------------------------------- activity resolution


def _parse_ts(raw: object) -> datetime:
    if isinstance(raw, str):
        try:
            ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if ts.tzinfo is not None:
                return ts
        except ValueError:
            pass
    return utcnow()


def _activity_from_run(db, viewer: Viewer, ref: RunActivityRef, run_module: RunModule, settings) -> Activity:
    existing = db.scalar(select(Activity).where(Activity.source == "run_module", Activity.source_ref == ref.run_id))
    if existing:
        if existing.user_id != viewer.id:
            raise not_found("Run not found.")
        return existing
    if not run_module.configured:
        raise ApiError(503, "run_module_unavailable", "Sharing runs needs the Run Module, which isn't connected.")
    try:
        run = run_module.get_run(viewer.token, ref.run_id)
    except RunModuleError as e:
        if e.status in (401, 403, 404):
            raise not_found("Run not found.") from None
        raise ApiError(502, "run_module_error", "Couldn't verify the run right now. Try again.") from None
    if str(run.get("run_id")) != ref.run_id:
        raise ApiError(502, "run_module_error", "The Run Module returned a different run.")
    run_status = run.get("status")
    if run_status == "rejected":
        raise invalid("Rejected runs can't be shared.", "run_rejected")
    if run_status not in SHAREABLE_RUN_STATUSES:
        raise conflict("This run is still being verified. Share it once it's done.", "run_processing")
    stats = run.get("stats") or {}
    distance = stats.get("distance_m")
    moving = stats.get("moving_time_s")
    activity = Activity(
        user_id=viewer.id,
        type="run",
        source="run_module",
        source_ref=ref.run_id,
        verified=run_status == "finalized",
        distance_m=int(distance) if isinstance(distance, (int, float)) and distance >= 0 else None,
        duration_s=int(moving) if isinstance(moving, (int, float)) and moving >= 0 else None,
        metrics={"run_status": run_status},
        started_at=_parse_ts(run.get("started_at")),
    )
    db.add(activity)
    try:
        db.flush()
    except IntegrityError:  # the same run shared concurrently: use the winner's row
        db.rollback()
        activity = db.scalar(select(Activity).where(Activity.source == "run_module", Activity.source_ref == ref.run_id))
        if not activity or activity.user_id != viewer.id:
            raise not_found("Run not found.") from None
        return activity
    social.after_activity_recorded(db, activity, settings)
    badges.after_activity(db, activity, settings)  # a finalized run shared before the Run Module published it
    return activity


def _resolve_activity(db, viewer: Viewer, body: CreatePostRequest, run_module: RunModule, settings) -> Activity | None:
    ref = body.activity
    if ref is None:
        return None
    if isinstance(ref, RunActivityRef):
        activity = _activity_from_run(db, viewer, ref, run_module, settings)
    elif isinstance(ref, ExistingActivityRef):
        activity = db.get(Activity, ref.activity_id)
        if not activity or activity.user_id != viewer.id:
            raise not_found("Activity not found.")
    else:
        assert isinstance(ref, ManualActivity)
        activity = Activity(
            user_id=viewer.id,
            type=ref.type,
            source="manual",
            verified=False,
            name=ref.name,
            distance_m=round(ref.distance_km * 1000) if ref.distance_km is not None else None,
            duration_s=ref.duration_minutes * 60 if ref.duration_minutes is not None else None,
            calories=ref.calories,
            metrics={},
            started_at=utcnow(),
        )
        db.add(activity)
        db.flush()
        social.after_activity_recorded(db, activity, settings)
    if db.scalar(select(Post.id).where(Post.activity_id == activity.id)):
        raise conflict("You've already shared this activity.", "already_shared")
    return activity


# --------------------------------------------------------------------------- posts


@router.post("/posts", response_model=PostOut, status_code=status.HTTP_201_CREATED)
def create_post(body: CreatePostRequest, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, run_module: RunModuleDep, limiter: Limiter):
    limiter.hit("post:create", str(viewer.id))
    limiter.hit("post:create:day", str(viewer.id))
    me = viewer.user

    media_id = None
    if body.media_id:
        m = db.get(Media, body.media_id)
        if not m or m.owner_id != me.id or m.purpose != "post" or m.status != "ready":
            raise invalid("That photo isn't an uploaded post photo of yours.", "invalid_media")
        media_id = m.id

    activity = _resolve_activity(db, viewer, body, run_module, settings)
    post = Post(
        author_id=me.id,
        caption=body.caption,
        activity_id=activity.id if activity else None,
        media_id=media_id,
        city_id=body.city_id or me.city_id,
        area=body.area if body.area is not None else me.area,
        backdrop_scene=body.backdrop.scene,
        backdrop_seed=body.backdrop.seed,
        sticker=body.sticker,
        crew_name=body.crew_name or None,
    )
    db.add(post)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise conflict("You've already shared this activity.", "already_shared") from None
    bump(db, UserStats, UserStats.user_id == me.id, posts_count=1)
    social.award_badge(db, me.id, "first_post")
    db.commit()
    row = social.load_visible_post(db, me.id, post.id)
    return social.serialize_posts(db, me.id, [row], settings, storage)[0]


@router.get("/posts/{post_id}", response_model=PostOut)
def get_post(post_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    row = social.load_visible_post(db, viewer.id, post_id)
    return social.serialize_posts(db, viewer.id, [row], settings, storage)[0]


@router.delete("/posts/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_post(post_id: uuid.UUID, db: DB, viewer: CurrentViewer):
    post, *_ = social.load_visible_post(db, viewer.id, post_id)
    if post.author_id != viewer.id and viewer.user.role not in MODERATOR_ROLES:
        raise forbidden("You can only delete your own posts.")
    res = db.execute(delete(Post).where(Post.id == post.id))  # likes, saves, comments cascade in the DB
    if res.rowcount == 1:
        bump(db, UserStats, UserStats.user_id == post.author_id, posts_count=-1)
    db.commit()


# --------------------------------------------------------------------------- likes & saves


def _likes(db, post_id: uuid.UUID) -> int:
    return int(db.scalar(select(Post.likes_count).where(Post.id == post_id)) or 0)


@router.post("/posts/{post_id}/like", response_model=LikeResult)
def like(post_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    post, *_ = social.load_visible_post(db, viewer.id, post_id)
    limiter.hit("like", str(viewer.id))
    if insert_ignore(db, PostLike, {"post_id": post.id, "user_id": viewer.id, "created_at": utcnow()}):
        bump(db, Post, Post.id == post.id, likes_count=1)
        if _likes(db, post.id) >= CROWD_FAVOURITE_LIKES:
            social.award_badge(db, post.author_id, "crowd_favourite")
    db.commit()
    return LikeResult(liked=True, likes_count=_likes(db, post.id))


@router.delete("/posts/{post_id}/like", response_model=LikeResult)
def unlike(post_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    post, *_ = social.load_visible_post(db, viewer.id, post_id)
    limiter.hit("like", str(viewer.id))
    res = db.execute(delete(PostLike).where(PostLike.post_id == post.id, PostLike.user_id == viewer.id))
    if res.rowcount == 1:
        bump(db, Post, Post.id == post.id, likes_count=-1)
    db.commit()
    return LikeResult(liked=False, likes_count=_likes(db, post.id))


@router.post("/posts/{post_id}/save", response_model=SaveResult)
def save(post_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    post, *_ = social.load_visible_post(db, viewer.id, post_id)
    limiter.hit("save", str(viewer.id))
    insert_ignore(db, PostSave, {"post_id": post.id, "user_id": viewer.id, "created_at": utcnow()})
    db.commit()
    return SaveResult(saved=True)


@router.delete("/posts/{post_id}/save", response_model=SaveResult)
def unsave(post_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    limiter.hit("save", str(viewer.id))
    db.execute(delete(PostSave).where(PostSave.post_id == post_id, PostSave.user_id == viewer.id))
    db.commit()
    return SaveResult(saved=False)


# --------------------------------------------------------------------------- comments


def _comment_rows_out(db, viewer: Viewer, rows, settings, storage) -> list[CommentOut]:

    urls = social.media_urls(db, storage, [u.avatar_media_id for _, u, _ in rows])
    xp_now = xp_cache.fresh(db, {u.id for _, u, _ in rows})
    mod = viewer.user.role in MODERATOR_ROLES
    return [
        CommentOut(
            id=c.id,
            post_id=c.post_id,
            author=social.user_summary(u, xp_now.get(u.id, xp), settings, urls.get(u.avatar_media_id)),
            body=c.body,
            created_at=c.created_at,
            can_delete=mod or c.author_id == viewer.id,
        )
        for c, u, xp in rows
    ]


@router.get("/posts/{post_id}/comments", response_model=CommentPage)
def list_comments(post_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, cursor: str | None = None, limit: int = 20):
    post, *_ = social.load_visible_post(db, viewer.id, post_id)
    n = clamp_limit(limit)
    stmt = (
        select(Comment, User, UserStats.xp)
        .join(User, User.id == Comment.author_id)
        .join(UserStats, UserStats.user_id == User.id)
        .where(Comment.post_id == post.id)
    )
    if cursor:
        ts, key = decode_uuid_cursor(cursor)
        stmt = stmt.where(after(Comment.created_at, Comment.id, ts, key))
    rows = db.execute(stmt.order_by(Comment.created_at.asc(), Comment.id.asc()).limit(n + 1)).all()
    page = rows[:n]
    nxt = encode_cursor(page[-1][0].created_at, page[-1][0].id) if len(rows) > n else None
    return CommentPage(items=_comment_rows_out(db, viewer, page, settings, storage), next_cursor=nxt, total=post.comments_count)


@router.post("/posts/{post_id}/comments", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
def create_comment(post_id: uuid.UUID, body: CreateCommentRequest, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    post, *_ = social.load_visible_post(db, viewer.id, post_id)
    limiter.hit("comment:create", str(viewer.id))
    comment = Comment(post_id=post.id, author_id=viewer.id, body=body.body)
    db.add(comment)
    db.flush()
    bump(db, Post, Post.id == post.id, comments_count=1)
    db.commit()
    return _comment_rows_out(db, viewer, [(comment, viewer.user, viewer.user.stats.xp)], settings, storage)[0]


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_comment(comment_id: uuid.UUID, db: DB, viewer: CurrentViewer):
    comment = db.get(Comment, comment_id)
    if not comment:
        raise not_found("Comment not found.")
    # A comment on a post you can no longer see is treated as missing.
    social.load_visible_post(db, viewer.id, comment.post_id)
    if comment.author_id != viewer.id and viewer.user.role not in MODERATOR_ROLES:
        raise forbidden("You can only delete your own comments.")
    res = db.execute(delete(Comment).where(Comment.id == comment.id))
    if res.rowcount == 1:
        bump(db, Post, Post.id == comment.post_id, comments_count=-1)
    db.commit()
