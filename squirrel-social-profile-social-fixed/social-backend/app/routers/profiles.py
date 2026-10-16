"""Profiles, username availability, people search and suggestions, saved posts.

Route order matters: the literal `/users/me/…`, `/users/search`, `/users/username/…` paths are
declared before `/users/{user_id}/…`.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Query
from sqlalchemy import case, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.db import utcnow
from app.deps import DB, AppSettings, CurrentViewer, Limiter, RunModuleDep, Storage
from app.errors import conflict, forbidden, invalid
from app.models import Activity, Crew, CrewMember, CrewVouch, Follow, Media, Post, PostSave, User, UserBlock, UserStats
from app.pagination import before, clamp_limit, decode_uuid_cursor, encode_cursor
from app.rules import normalize_username, username_problem
from app.schemas import (
    BadgeOut,
    BadgesResponse,
    FeedResponse,
    ProfileResponse,
    ProfileCrew,
    ProfileStats,
    ProfileUser,
    UpdateProfileRequest,
    UsernameAvailability,
    UserPage,
)
from app.services import badges as badge_rules
from app.services import community, social, xp_cache
from app.services.social import bump

router = APIRouter(prefix="/v1", tags=["profiles"])

RECENT_POSTS = 9
RECENT_ACTIVITIES = 10


def build_profile(db, viewer, user: User, settings, storage, *, is_me: bool) -> ProfileResponse:
    stats: UserStats = user.stats
    visible = is_me or social.can_see_content(db, viewer.id, user)
    relationship = None if is_me else social.follow_status(db, viewer.id, user.id)

    recent_posts, recent_activities, badges, crews = [], [], [], []
    month = {"month": None, "km": 0.0, "runs": 0, "workouts": 0}
    if visible:
        month = community.month_verification(db, user.id, settings)
        vouches = (select(CrewVouch.crew_id, func.count().label("n")).where(CrewVouch.vouchee_id == user.id)
                   .group_by(CrewVouch.crew_id).subquery())
        crews = [
            ProfileCrew(id=c.id, name=c.name, interest=c.interest, role=m.role, member_since=m.joined_at, vouches=int(n or 0))
            for c, m, n in db.execute(
                select(Crew, CrewMember, vouches.c.n)
                .join(CrewMember, (CrewMember.crew_id == Crew.id) & (CrewMember.user_id == user.id))
                .outerjoin(vouches, vouches.c.crew_id == Crew.id)
                .order_by(CrewMember.joined_at)
            ).all()
        ]
        rows = db.execute(
            social.posts_query().where(Post.author_id == user.id).order_by(Post.created_at.desc(), Post.id.desc()).limit(RECENT_POSTS)
        ).all()
        recent_posts = social.serialize_posts(db, viewer.id, rows, settings, storage)
        acts = db.scalars(
            select(Activity).where(Activity.user_id == user.id).order_by(Activity.started_at.desc(), Activity.id.desc()).limit(RECENT_ACTIVITIES)
        ).all()
        recent_activities = [social.activity_out(a) for a in acts]
        badges = [BadgeOut(id=b.id, kind=b.kind, title=b.title, description=b.description, awarded_at=b.awarded_at) for b in social.badges_for(db, user.id)]

    avatar_url = None
    if user.avatar_media_id and storage.configured:
        m = db.get(Media, user.avatar_media_id)
        avatar_url = storage.public_url(m.storage_key) if m and m.status == "ready" else None

    activities_total = social.count(db, select(Activity.id).where(Activity.user_id == user.id)) if visible else 0
    return ProfileResponse(
        user=ProfileUser(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            avatar_look=user.avatar_look,
            avatar_url=avatar_url,
            bio=user.bio if visible else None,
            city_id=user.city_id if visible else None,
            area=user.area if visible else None,
            college=user.college if visible else None,
            hostel=user.hostel if visible else None,
            interests=list(user.interests or []) if visible else [],
            visibility=user.visibility,
            verified=user.verified,
            created_at=user.created_at,
        ),
        stats=ProfileStats(
            xp=stats.xp,
            level=social.level_for(stats.xp, settings),
            level_xp=stats.xp % settings.xp_per_level,
            xp_per_level=settings.xp_per_level,
            xp_synced_at=stats.xp_synced_at,
            streak_days=social.streak_days(db, user.id, settings) if visible else 0,
            followers=stats.followers_count,
            following=stats.following_count,
            posts=stats.posts_count,
            activities=activities_total,
            month=month["month"],
            month_km=month["km"],
            month_runs=month["runs"],
            month_workouts=month["workouts"],
        ),
        badges=badges,
        crews=crews,
        recent_posts=recent_posts,
        recent_activities=recent_activities,
        is_me=is_me,
        restricted=not visible,
        relationship=relationship,
        username_confirmed=user.username_confirmed if is_me else None,
    )


def sync_xp(db, viewer, run_module) -> None:
    """Refresh the cached XP from the Run Module (the only XP authority). Best effort."""
    xp = run_module.get_xp(viewer.token)
    if xp is not None:
        db.execute(update(UserStats).where(UserStats.user_id == viewer.id).values(xp=xp, xp_synced_at=utcnow()))
        db.commit()
        db.refresh(viewer.user.stats)


@router.get("/users/me/profile", response_model=ProfileResponse)
def get_my_profile(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, run_module: RunModuleDep):
    sync_xp(db, viewer, run_module)
    return build_profile(db, viewer, viewer.user, settings, storage, is_me=True)


@router.patch("/users/me/profile", response_model=ProfileResponse)
def update_my_profile(body: UpdateProfileRequest, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    limiter.hit("profile:update", str(viewer.id))
    user = viewer.user
    sent = body.model_fields_set

    if "username" in sent:
        if body.username is None:
            raise invalid("Username can't be empty.", "invalid_username")
        name = normalize_username(body.username)
        problem = username_problem(name)
        if problem:
            raise invalid(problem, "invalid_username")
        if name != user.username:
            taken = db.scalar(select(User.id).where(User.username == name, User.id != user.id))
            if taken:
                raise conflict("That username is taken.", "username_taken")
            user.username = name
        user.username_confirmed = True

    for field in ("display_name", "visibility"):
        if field in sent:
            value = getattr(body, field)
            if value is None:
                raise invalid(f"{field} can't be null.")
            setattr(user, field, value)
    if "bio" in sent:
        user.bio = body.bio or ""
    for field in ("city_id", "area", "college"):
        if field in sent:
            setattr(user, field, getattr(body, field) or None)
    if "hostel" in sent:
        if body.hostel and body.hostel not in settings.hostels:
            raise invalid("Pick one of the listed hostels." if settings.hostels else "Hostels aren't set up yet.", "invalid_hostel")
        user.hostel = body.hostel or None
    if "interests" in sent:
        user.interests = body.interests or []
    if "avatar_look" in sent:
        user.avatar_look = body.avatar_look.model_dump() if body.avatar_look else None
    if "avatar_media_id" in sent:
        if body.avatar_media_id is None:
            user.avatar_media_id = None
        else:
            m = db.get(Media, body.avatar_media_id)
            if not m or m.owner_id != user.id or m.purpose != "avatar" or m.status != "ready":
                raise invalid("That photo isn't an uploaded avatar of yours.", "invalid_media")
            user.avatar_media_id = m.id

    # Going public accepts every pending follow request.
    if "visibility" in sent and body.visibility == "public":
        pending = db.scalars(select(Follow.follower_id).where(Follow.followee_id == user.id, Follow.status == "pending")).all()
        if pending:
            db.execute(update(Follow).where(Follow.followee_id == user.id, Follow.status == "pending").values(status="accepted"))
            bump(db, UserStats, UserStats.user_id == user.id, followers_count=len(pending))
            bump(db, UserStats, UserStats.user_id.in_(pending), following_count=1)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise conflict("That username is taken.", "username_taken") from None
    db.refresh(user)
    return build_profile(db, viewer, user, settings, storage, is_me=True)


@router.get("/users/username/{username}/availability", response_model=UsernameAvailability)
def username_availability(username: str, db: DB, viewer: CurrentViewer, limiter: Limiter):
    limiter.hit("username:check", str(viewer.id))
    name = normalize_username(username)
    problem = username_problem(name)
    if problem:
        return UsernameAvailability(username=name, available=False, reason=problem)
    owner = db.scalar(select(User.id).where(User.username == name))
    if owner and owner != viewer.id:
        return UsernameAvailability(username=name, available=False, reason="That username is taken.")
    return UsernameAvailability(username=name, available=True, reason=None)


@router.get("/users/search", response_model=UserPage)
def search_users(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, q: str = Query(min_length=2, max_length=40), limit: int = 20):
    term = q.strip().lower().lstrip("@")
    if len(term) < 2:
        raise invalid("Type at least 2 characters.")
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = db.execute(
        select(User, UserStats.xp)
        .join(UserStats, UserStats.user_id == User.id)
        .where(or_(User.username.like(f"{escaped}%", escape="\\"), func.lower(User.display_name).like(f"%{escaped}%", escape="\\")))
        .order_by(case((User.username.like(f"{escaped}%", escape="\\"), 0), else_=1), UserStats.followers_count.desc(), User.id)
        .limit(clamp_limit(limit))
    ).all()
    items = social.serialize_user_rows(db, viewer.id, [(u, xp, None) for u, xp in rows], settings, storage)
    return UserPage(items=items, next_cursor=None)


@router.get("/users/suggestions", response_model=UserPage)
def suggestions(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limit: int = 10):
    """People you don't follow yet, and nobody blocked either way: same city first, then most followed."""
    me = viewer.user
    order = [UserStats.followers_count.desc(), User.created_at.desc(), User.id]
    if me.city_id:
        order.insert(0, case((User.city_id == me.city_id, 0), else_=1))
    rows = db.execute(
        select(User, UserStats.xp)
        .join(UserStats, UserStats.user_id == User.id)
        .where(
            User.id != me.id,
            User.id.not_in(select(Follow.followee_id).where(Follow.follower_id == me.id)),
            # Blocked either way: never suggested.
            User.id.not_in(select(UserBlock.blocked_id).where(UserBlock.blocker_id == me.id)),
            User.id.not_in(select(UserBlock.blocker_id).where(UserBlock.blocked_id == me.id)),
        )
        .order_by(*order)
        .limit(min(20, max(1, limit)))
    ).all()
    items = social.serialize_user_rows(db, viewer.id, [(u, xp, None) for u, xp in rows], settings, storage)
    return UserPage(items=items, next_cursor=None)


@router.get("/users/me/saved", response_model=FeedResponse)
def saved_posts(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, cursor: str | None = None, limit: int = 20):
    n = clamp_limit(limit)
    stmt = (
        social.posts_query()
        .add_columns(PostSave.created_at)
        .join(PostSave, (PostSave.post_id == Post.id) & (PostSave.user_id == viewer.id))
        .where(social.post_visible_clause(viewer.id))
    )
    if cursor:
        ts, key = decode_uuid_cursor(cursor)
        stmt = stmt.where(before(PostSave.created_at, PostSave.post_id, ts, key))
    rows = db.execute(stmt.order_by(PostSave.created_at.desc(), PostSave.post_id.desc()).limit(n + 1)).all()
    page = rows[:n]
    nxt = encode_cursor(page[-1][4], page[-1][0].id) if len(rows) > n else None
    return FeedResponse(items=social.serialize_posts(db, viewer.id, [r[:4] for r in page], settings, storage), next_cursor=nxt)


@router.get("/users/me/badges", response_model=BadgesResponse)
def my_badges(db: DB, viewer: CurrentViewer, settings: AppSettings):
    """Every badge, earned or not, with progress toward Early Bird, Night Owl and Park Regular."""
    return BadgesResponse(badges=badge_rules.statuses(db, viewer.id, settings))


@router.get("/users/{user_id}/profile", response_model=ProfileResponse)
def get_profile(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    user = social.get_user_or_404(db, user_id)
    if user.id != viewer.id and xp_cache.fresh(db, [user.id]):
        db.refresh(user.stats)
    return build_profile(db, viewer, user, settings, storage, is_me=user.id == viewer.id)


@router.get("/users/{user_id}/posts", response_model=FeedResponse)
def user_posts(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, cursor: str | None = None, limit: int = 20):
    user = social.get_user_or_404(db, user_id)
    if not social.can_see_content(db, viewer.id, user):
        raise forbidden("This account is private.")
    n = clamp_limit(limit)
    stmt = social.posts_query().where(Post.author_id == user.id)
    if cursor:
        ts, key = decode_uuid_cursor(cursor)
        stmt = stmt.where(before(Post.created_at, Post.id, ts, key))
    rows = db.execute(stmt.order_by(Post.created_at.desc(), Post.id.desc()).limit(n + 1)).all()
    page = rows[:n]
    nxt = encode_cursor(page[-1][0].created_at, page[-1][0].id) if len(rows) > n else None
    return FeedResponse(items=social.serialize_posts(db, viewer.id, page, settings, storage), next_cursor=nxt)
