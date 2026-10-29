"""Shared helpers of the community routes: local days, batched user summaries, "friends" for
check-ins, and the verified monthly totals."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.models import Activity, CrewMember, Follow, User, UserStats
from app.schemas import UserSummary
from app.services import social, xp_cache
from app.services.media import MediaStorage


def zone(settings: Settings) -> ZoneInfo:
    return ZoneInfo(settings.community_timezone)


def local_today(settings: Settings, now: datetime | None = None) -> date:
    return (now or utcnow()).astimezone(zone(settings)).date()


def day_start(day: date, settings: Settings) -> datetime:
    """The UTC instant a local day starts."""
    return datetime.combine(day, time.min, tzinfo=zone(settings))


def summaries(db: Session, user_ids: Iterable[uuid.UUID], settings: Settings, storage: MediaStorage) -> dict[uuid.UUID, UserSummary]:
    """UserSummary for each id, in two queries (and a batch XP refresh for stale figures)."""
    ids = set(user_ids)
    if not ids:
        return {}
    xp_cache.fresh(db, ids)
    rows = db.execute(select(User, UserStats.xp).join(UserStats, UserStats.user_id == User.id).where(User.id.in_(ids))).all()
    urls = social.media_urls(db, storage, [u.avatar_media_id for u, _ in rows])
    return {u.id: social.user_summary(u, xp, settings, urls.get(u.avatar_media_id)) for u, xp in rows}


def friends_among(db: Session, me: uuid.UUID, candidates: Iterable[uuid.UUID]) -> list[uuid.UUID]:
    """Of `candidates`, those who may be told about my check-in: people who follow me (they chose
    to hear from me), or who share a crew with me. Anyone else is dropped: no notifying strangers."""
    ids = [c for c in dict.fromkeys(candidates) if c != me]
    if not ids:
        return []
    my_crews = select(CrewMember.crew_id).where(CrewMember.user_id == me)
    allowed = db.scalars(
        select(User.id).where(
            User.id.in_(ids),
            or_(
                exists().where(Follow.follower_id == User.id, Follow.followee_id == me, Follow.status == "accepted"),
                exists().where(CrewMember.user_id == User.id, CrewMember.crew_id.in_(my_crews)),
            ),
        )
    ).all()
    keep = set(allowed)
    return [i for i in ids if i in keep]


def month_verification(db: Session, user_id: uuid.UUID, settings: Settings, now: datetime | None = None) -> dict:
    """This local month's verified totals: runs the Run Module measured and accepted, and workouts
    the Exercise backend measured. Manual activities never count."""
    today = local_today(settings, now)
    start = day_start(today.replace(day=1), settings)
    rows = db.execute(
        select(Activity.type, Activity.distance_m).where(
            Activity.user_id == user_id, Activity.verified.is_(True), Activity.source != "manual",
            Activity.started_at >= start,
        )
    ).all()
    runs = [d for t, d in rows if t == "run"]
    return {
        "month": today.strftime("%Y-%m"),
        "km": round(sum(d or 0 for d in runs) / 1000, 1),
        "runs": len(runs),
        "workouts": sum(1 for t, _ in rows if t == "workout"),
    }


def daily_stats(db: Session, viewer_id: uuid.UUID, settings: Settings, days: int, now: datetime | None = None) -> dict:
    tz = zone(settings)
    today = local_today(settings, now)
    first = today - timedelta(days=days - 1)
    rows = db.execute(
        select(Activity.user_id, Activity.type, Activity.distance_m, Activity.verified, Activity.started_at)
        .where(Activity.started_at >= day_start(first, settings), Activity.source != "manual")
    ).all()
    per_day: dict[date, dict] = {first + timedelta(days=i): {"users": set(), "runs": 0, "km": 0.0, "workouts": 0} for i in range(days)}
    me = {"runs": 0, "km": 0.0, "workouts": 0}
    for user_id, kind, distance, verified, started in rows:
        day = started.astimezone(tz).date()
        bucket = per_day.get(day)
        if bucket is None:
            continue
        bucket["users"].add(user_id)
        km = (distance or 0) / 1000 if kind == "run" and verified else 0.0
        if kind == "run":
            bucket["runs"] += 1
            bucket["km"] += km
        elif kind == "workout":
            bucket["workouts"] += 1
        if user_id == viewer_id and day == today:
            if kind == "run":
                me["runs"] += 1
                me["km"] += km
            elif kind == "workout":
                me["workouts"] += 1
    out = [
        {"day": d, "active_members": len(b["users"]), "runs": b["runs"], "km": round(b["km"], 1), "workouts": b["workouts"]}
        for d, b in sorted(per_day.items(), reverse=True)
    ]
    me["km"] = round(me["km"], 1)
    return {"timezone": settings.community_timezone, "today": out[0], "me_today": me, "days": out}


def crew_member_ids(db: Session, crew_id: uuid.UUID) -> list[uuid.UUID]:
    return list(db.scalars(select(CrewMember.user_id).where(CrewMember.crew_id == crew_id)))


def is_member(db: Session, crew_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    return bool(db.scalar(select(exists().where(and_(CrewMember.crew_id == crew_id, CrewMember.user_id == user_id)))))
