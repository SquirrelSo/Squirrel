"""Shared domain logic: visibility, batched serialisation, counters, streaks and badges.

Serialisation is batched on purpose. A feed page of N posts costs a fixed number of queries
(posts+authors+stats+activities in one join, then one query each for "liked by me", "saved by
me" and media URLs) — never one query per post or per author.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import Select, and_, exists, func, or_, select, update
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.errors import not_found
from app.models import Activity, Badge, Follow, Media, Post, PostLike, PostSave, User, UserBadge, UserStats
from app.schemas import ActivityOut, BackdropOut, FollowListItem, FollowStatus, PostOut, UserSummary
from app.services import xp_cache
from app.services.media import MediaStorage

# --------------------------------------------------------------------------- db helpers


def insert_ignore(db: Session, model, values: dict) -> bool:
    """INSERT … ON CONFLICT DO NOTHING. True if a row was inserted. The unique constraints, not
    a read-then-write check, decide duplicates, so concurrent requests can't double count."""
    dialect = db.get_bind().dialect.name
    pk = model.__table__.primary_key.columns.values()[0]
    ins = (postgresql.insert if dialect == "postgresql" else sqlite.insert)(model).values(**values).on_conflict_do_nothing()
    # RETURNING, not rowcount: psycopg 3 reports rowcount -1 for this statement.
    return db.execute(ins.returning(pk)).first() is not None


def bump(db: Session, model, where, **deltas: int) -> None:
    """Atomic counter update: SET col = col + delta."""
    db.execute(update(model).where(where).values({k: getattr(model, k) + v for k, v in deltas.items()}))


# --------------------------------------------------------------------------- progression


def level_for(xp: int, settings: Settings) -> int:
    return xp // settings.xp_per_level + 1


def streak_days(db: Session, user_id: uuid.UUID, settings: Settings, now: datetime | None = None) -> int:
    """Consecutive local days with at least one activity, ending today (or yesterday, so a
    streak isn't "broken" before the day is over). Bounded to the last 400 days."""
    tz = ZoneInfo(settings.streak_timezone)
    now = now or utcnow()
    since = now - timedelta(days=400)
    stamps = db.scalars(select(Activity.started_at).where(Activity.user_id == user_id, Activity.started_at >= since)).all()
    days: set[date] = {s.astimezone(tz).date() for s in stamps}
    today = now.astimezone(tz).date()
    day = today if today in days else today - timedelta(days=1)
    n = 0
    while day in days:
        n += 1
        day -= timedelta(days=1)
    return n


def award_badge(db: Session, user_id: uuid.UUID, badge_id: str) -> bool:
    return insert_ignore(db, UserBadge, {"user_id": user_id, "badge_id": badge_id, "awarded_at": utcnow()})


def after_activity_recorded(db: Session, activity: Activity, settings: Settings) -> None:
    if activity.type == "run" and activity.source == "run_module":
        award_badge(db, activity.user_id, "first_run")
    if streak_days(db, activity.user_id, settings) >= 7:
        award_badge(db, activity.user_id, "streak_7")


# --------------------------------------------------------------------------- relationships


def followed_ids(viewer_id: uuid.UUID):
    """Subquery: ids the viewer follows (accepted only)."""
    return select(Follow.followee_id).where(Follow.follower_id == viewer_id, Follow.status == "accepted")


def post_visible_clause(viewer_id: uuid.UUID, author=User):
    """Posts a viewer may see: public authors, their own, and private authors they follow."""
    return or_(author.visibility == "public", Post.author_id == viewer_id, Post.author_id.in_(followed_ids(viewer_id)))


def follow_status(db: Session, viewer_id: uuid.UUID, other_id: uuid.UUID) -> FollowStatus:
    rows = db.execute(
        select(Follow.follower_id, Follow.status).where(
            or_(
                and_(Follow.follower_id == viewer_id, Follow.followee_id == other_id),
                and_(Follow.follower_id == other_id, Follow.followee_id == viewer_id),
            )
        )
    ).all()
    mine = next((s for f, s in rows if f == viewer_id), None)
    theirs = next((s for f, s in rows if f == other_id), None)
    return FollowStatus(following=mine == "accepted", requested=mine == "pending", followed_by=theirs == "accepted")


def can_see_content(db: Session, viewer_id: uuid.UUID, user: User) -> bool:
    if user.id == viewer_id or user.visibility == "public":
        return True
    return bool(
        db.scalar(
            select(exists().where(Follow.follower_id == viewer_id, Follow.followee_id == user.id, Follow.status == "accepted"))
        )
    )


def get_user_or_404(db: Session, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if not user:
        raise not_found("User not found.")
    return user


# --------------------------------------------------------------------------- serialisation


def media_urls(db: Session, storage: MediaStorage, media_ids: Iterable[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {m for m in media_ids if m}
    if not ids or not storage.configured:
        return {}
    rows = db.execute(select(Media.id, Media.storage_key).where(Media.id.in_(ids), Media.status == "ready")).all()
    return {mid: storage.public_url(key) for mid, key in rows}


def user_summary(user: User, xp: int, settings: Settings, avatar_url: str | None) -> UserSummary:
    return UserSummary(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        avatar_look=user.avatar_look,
        avatar_url=avatar_url,
        level=level_for(xp, settings),
        verified=user.verified,
    )


def activity_out(a: Activity) -> ActivityOut:
    km = round(a.distance_m / 1000, 2) if a.distance_m is not None else None
    minutes = round(a.duration_s / 60) if a.duration_s is not None else None
    pace = None
    if a.type == "run" and a.distance_m and a.duration_s:
        sec_per_km = a.duration_s / (a.distance_m / 1000)
        m, s = divmod(round(sec_per_km), 60)
        pace = f"{m}'{s:02d}\""
    return ActivityOut(
        id=a.id,
        type=a.type,
        source=a.source,
        verified=a.verified,
        name=a.name,
        distance_km=km,
        duration_minutes=minutes,
        pace=pace,
        calories=a.calories,
        started_at=a.started_at,
    )


def posts_query() -> Select:
    """Posts with author, author stats and activity in one round trip."""
    return (
        select(Post, User, UserStats.xp, Activity)
        .join(User, User.id == Post.author_id)
        .join(UserStats, UserStats.user_id == User.id)
        .outerjoin(Activity, Activity.id == Post.activity_id)
    )


def serialize_posts(
    db: Session, viewer_id: uuid.UUID, rows: Sequence, settings: Settings, storage: MediaStorage
) -> list[PostOut]:
    if not rows:
        return []
    ids = [r[0].id for r in rows]
    liked = set(db.scalars(select(PostLike.post_id).where(PostLike.user_id == viewer_id, PostLike.post_id.in_(ids))))
    saved = set(db.scalars(select(PostSave.post_id).where(PostSave.user_id == viewer_id, PostSave.post_id.in_(ids))))
    author_ids = {r[1].id for r in rows}
    follows = dict(db.execute(select(Follow.followee_id, Follow.status).where(Follow.follower_id == viewer_id, Follow.followee_id.in_(author_ids))).all())
    urls = media_urls(db, storage, [r[0].media_id for r in rows] + [r[1].avatar_media_id for r in rows])
    xp_now = xp_cache.fresh(db, author_ids)
    out = []
    for post, author, xp, activity in rows:
        out.append(
            PostOut(
                id=post.id,
                author=user_summary(author, xp_now.get(author.id, xp), settings, urls.get(author.avatar_media_id)),
                caption=post.caption,
                activity=activity_out(activity) if activity else None,
                city_id=post.city_id,
                area=post.area,
                backdrop=BackdropOut(scene=post.backdrop_scene, seed=post.backdrop_seed),
                media_url=urls.get(post.media_id),
                sticker=post.sticker,
                crew_name=post.crew_name,
                likes_count=post.likes_count,
                comments_count=post.comments_count,
                liked_by_me=post.id in liked,
                saved_by_me=post.id in saved,
                is_mine=post.author_id == viewer_id,
                following_author=follows.get(author.id) == "accepted",
                requested_author=follows.get(author.id) == "pending",
                created_at=post.created_at,
            )
        )
    return out


def load_visible_post(db: Session, viewer_id: uuid.UUID, post_id: uuid.UUID):
    """(post, author, xp, activity) if the viewer may see it, else 404 — a private author's post
    is indistinguishable from a missing one."""
    row = db.execute(posts_query().where(Post.id == post_id, post_visible_clause(viewer_id))).first()
    if not row:
        raise not_found("Post not found.")
    return row


def serialize_user_rows(
    db: Session,
    viewer_id: uuid.UUID,
    rows: Sequence[tuple[User, int, datetime | None]],
    settings: Settings,
    storage: MediaStorage,
) -> list[FollowListItem]:
    """(user, xp, followed_at) rows → list items with the viewer's relationship, in 2 queries."""
    if not rows:
        return []
    ids = [u.id for u, _, _ in rows]
    rel = dict(db.execute(select(Follow.followee_id, Follow.status).where(Follow.follower_id == viewer_id, Follow.followee_id.in_(ids))).all())
    urls = media_urls(db, storage, [u.avatar_media_id for u, _, _ in rows])
    xp_now = xp_cache.fresh(db, ids)
    items = []
    for u, xp, at in rows:
        s = user_summary(u, xp_now.get(u.id, xp), settings, urls.get(u.avatar_media_id))
        items.append(
            FollowListItem(
                **s.model_dump(),
                city_id=u.city_id,
                area=u.area,
                interests=list(u.interests or [])[:3],
                followed_at=at,
                following=rel.get(u.id) == "accepted",
                requested=rel.get(u.id) == "pending",
                is_me=u.id == viewer_id,
            )
        )
    return items


def badges_for(db: Session, user_id: uuid.UUID):
    return db.execute(
        select(Badge.id, Badge.kind, Badge.title, Badge.description, UserBadge.awarded_at)
        .join(UserBadge, UserBadge.badge_id == Badge.id)
        .where(UserBadge.user_id == user_id)
        .order_by(UserBadge.awarded_at)
    ).all()


def count(db: Session, stmt) -> int:
    return int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)

