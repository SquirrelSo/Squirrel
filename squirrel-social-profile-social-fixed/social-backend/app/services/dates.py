"""Squirrel Dates: "you both know this part of campus". Advisory only.

A suggestion is one person, one named zone and one time, worked out from zone visits you share. It
never creates an invitation or a meetup and never tells the other person anything: the member who
wants to meet plans an event through the normal events flow (POST /v1/events) themselves.

Who can be suggested to whom — every rule applies in both directions:
  * both opted in (dates_prefs.enabled); no row = off
  * neither has blocked the other (user_blocks)
  * the viewer didn't press "Maybe later" on them in the last DISMISS_DAYS
  * both passed the same named zone at least MIN_VISITS times in the last WINDOW_DAYS, on runs the
    Run Module finalized (flagged runs never reach Social)

Zone visits are recorded only while a member is opted in, hold the zone and the local day and hour
(never a point, a route or a minute), are deleted on opt-out and pruned after KEEP_DAYS.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.models import Activity, DateDismissal, DatesPref, UserBlock, ZoneVisit
from app.services.route_points import RoutePoints
from app.services.social import insert_ignore
from app.services.zones import Zone, zones_visited

WINDOW_DAYS = 28
KEEP_DAYS = 56
MIN_VISITS = 2
DISMISS_DAYS = 30
MAX_SUGGESTIONS = 3
BACKFILL_RUNS = 60
# A suggested time is at least this far ahead, and only between these local hours.
LEAD = timedelta(hours=2)
FIRST_HOUR, LAST_HOUR = 6, 21

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


@dataclass(frozen=True)
class Suggestion:
    other_id: uuid.UUID
    zone: Zone
    suggested_time: datetime | None
    reason: str


# --------------------------------------------------------------------------- consent & blocks


def is_enabled(db: Session, user_id: uuid.UUID) -> bool:
    return bool(db.scalar(select(DatesPref.enabled).where(DatesPref.user_id == user_id)))


def blocked_either_way(db: Session, me: uuid.UUID) -> set[uuid.UUID]:
    rows = db.execute(select(UserBlock.blocker_id, UserBlock.blocked_id).where(
        or_(UserBlock.blocker_id == me, UserBlock.blocked_id == me))).all()
    return {b if a == me else a for a, b in rows}


def is_blocked(db: Session, a: uuid.UUID, b: uuid.UUID) -> bool:
    return b in blocked_either_way(db, a)


def set_enabled(db: Session, user_id: uuid.UUID, on: bool, settings: Settings, reader: RoutePoints) -> None:
    pref = db.get(DatesPref, user_id)
    if pref is None:
        pref = DatesPref(user_id=user_id, enabled=on, updated_at=utcnow())
        db.add(pref)
    else:
        pref.enabled, pref.updated_at = on, utcnow()
    db.flush()
    if on:
        backfill(db, user_id, settings, reader)
    else:
        db.execute(delete(ZoneVisit).where(ZoneVisit.user_id == user_id))


# --------------------------------------------------------------------------- zone visits


def record_visits(db: Session, activity: Activity, settings: Settings, reader: RoutePoints) -> int:
    """Zones this finished run passed, for an opted-in runner. Idempotent per (run, zone)."""
    if (not settings.zones or activity.type != "run" or activity.source != "run_module" or not activity.source_ref
            or not is_enabled(db, activity.user_id)):
        return 0
    visited = zones_visited(reader.points(db, activity.source_ref), settings.zones)
    tz = ZoneInfo(settings.community_timezone)
    added = 0
    for zone_id, at in visited.items():
        local = at.astimezone(tz)
        added += insert_ignore(db, ZoneVisit, {
            "activity_id": activity.id, "zone_id": zone_id, "user_id": activity.user_id,
            "visited_on": local.date(), "weekday": local.weekday(), "hour": local.hour,
        })
    cutoff = _today(settings) - timedelta(days=KEEP_DAYS)
    db.execute(delete(ZoneVisit).where(ZoneVisit.user_id == activity.user_id, ZoneVisit.visited_on < cutoff))
    return added


def backfill(db: Session, user_id: uuid.UUID, settings: Settings, reader: RoutePoints) -> int:
    """On opt-in: the zone visits of the member's recent runs, so suggestions don't wait a week."""
    since = utcnow() - timedelta(days=WINDOW_DAYS)
    runs = db.scalars(select(Activity).where(
        Activity.user_id == user_id, Activity.type == "run", Activity.source == "run_module", Activity.started_at >= since,
    ).order_by(Activity.started_at.desc()).limit(BACKFILL_RUNS)).all()
    return sum(record_visits(db, run, settings, reader) for run in runs)


# --------------------------------------------------------------------------- suggestions


def dismiss(db: Session, me: uuid.UUID, other: uuid.UUID) -> None:
    row = db.get(DateDismissal, (me, other))
    if row is None:
        db.add(DateDismissal(user_id=me, other_id=other, dismissed_at=utcnow()))
    else:
        row.dismissed_at = utcnow()


def suggestions(db: Session, me: uuid.UUID, settings: Settings, *, only: uuid.UUID | None = None,
                now: datetime | None = None) -> list[Suggestion]:
    now = now or utcnow()
    zones = {z.id: z for z in settings.zones}
    if not zones or not is_enabled(db, me) or only == me:
        return []
    since = _today(settings, now) - timedelta(days=WINDOW_DAYS)

    mine = _buckets(db, [ZoneVisit.user_id == me], since)
    my_totals = {z: sum(b.values()) for z, b in mine.get(me, {}).items()}
    my_zones = [z for z, n in my_totals.items() if n >= MIN_VISITS and z in zones]
    if not my_zones:
        return []

    excluded = blocked_either_way(db, me) | set(db.scalars(select(DateDismissal.other_id).where(
        DateDismissal.user_id == me, DateDismissal.dismissed_at >= now - timedelta(days=DISMISS_DAYS))).all())
    opted_in = select(DatesPref.user_id).where(DatesPref.enabled.is_(True))
    where = [ZoneVisit.zone_id.in_(my_zones), ZoneVisit.user_id != me, ZoneVisit.user_id.in_(opted_in)]
    if only is not None:
        where.append(ZoneVisit.user_id == only)
    theirs = _buckets(db, where, since)

    ranked = []
    for other, by_zone in theirs.items():
        if other in excluded:
            continue
        best = None  # ((both, together), zone); ties go to the first zone id
        for zone_id, buckets in sorted(by_zone.items()):
            n = sum(buckets.values())
            if n < MIN_VISITS:
                continue
            key = (min(n, my_totals[zone_id]), n + my_totals[zone_id])
            if best is None or key > best[0]:
                best = (key, zone_id)
        if best:
            ranked.append((*best[0], other, best[1]))
    ranked.sort(key=lambda r: (-r[0], -r[1], str(r[2])))

    out = []
    for _, _, other, zone_id in ranked[:MAX_SUGGESTIONS]:
        slot, shared = _best_slot(mine[me][zone_id], theirs[other][zone_id])
        when = _next_occurrence(slot, settings, now) if slot else None
        out.append(Suggestion(other, zones[zone_id], when, _reason(zones[zone_id], slot if shared else None)))
    return out


def _buckets(db: Session, where: list, since: date) -> dict[uuid.UUID, dict[str, dict[tuple[int, int], int]]]:
    """user → zone → (weekday, hour) → visits, since `since`."""
    rows = db.execute(
        select(ZoneVisit.user_id, ZoneVisit.zone_id, ZoneVisit.weekday, ZoneVisit.hour, func.count())
        .where(ZoneVisit.visited_on >= since, *where)
        .group_by(ZoneVisit.user_id, ZoneVisit.zone_id, ZoneVisit.weekday, ZoneVisit.hour)
    ).all()
    out: dict = defaultdict(lambda: defaultdict(dict))
    for user_id, zone_id, weekday, hour, n in rows:
        out[user_id][zone_id][(weekday, hour)] = n
    return out


def _best_slot(mine: dict[tuple[int, int], int], theirs: dict[tuple[int, int], int]) -> tuple[tuple[int, int] | None, bool]:
    """The weekday and hour you both use the zone most (else the busiest for either of you), within
    sociable hours. Returns (slot, both_use_it)."""
    slots = [s for s in set(mine) | set(theirs) if FIRST_HOUR <= s[1] <= LAST_HOUR]
    if not slots:
        return None, False
    best = max(slots, key=lambda s: (min(mine.get(s, 0), theirs.get(s, 0)), mine.get(s, 0) + theirs.get(s, 0), -s[0], -s[1]))
    return best, min(mine.get(best, 0), theirs.get(best, 0)) > 0


def _next_occurrence(slot: tuple[int, int], settings: Settings, now: datetime) -> datetime:
    tz = ZoneInfo(settings.community_timezone)
    local_now = now.astimezone(tz)
    weekday, hour = slot
    for k in range(8):
        day = local_now.date() + timedelta(days=k)
        if day.weekday() != weekday:
            continue
        at = datetime.combine(day, time(hour), tzinfo=tz)
        if at >= local_now + LEAD:
            return at.astimezone(ZoneInfo("UTC"))
    raise AssertionError("a weekday recurs within 8 days")


def _reason(zone: Zone, slot: tuple[int, int] | None) -> str:
    text = f"You're both often around {zone.name}."
    if slot:
        weekday, hour = slot
        part = "mornings" if hour < 12 else "afternoons" if hour < 17 else "evenings"
        text += f" You both tend to be there on {WEEKDAYS[weekday]} {part}."
    return text


def _today(settings: Settings, now: datetime | None = None) -> date:
    return (now or utcnow()).astimezone(ZoneInfo(settings.community_timezone)).date()
