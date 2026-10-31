"""Activity badges: Early Bird, Night Owl and Park Regular, awarded as activities arrive.

Rules (thresholds are Settings, with SOCIAL_* overrides; times are in the community time zone):
  early_bird    `early_bird_activities` verified activities that started from `early_bird_from_hour`:00
                to before `early_bird_hour`:00 (4–7 AM)
  night_owl     `night_owl_activities` verified activities that started from `night_owl_hour`:00 to
                before `early_bird_from_hour`:00 (9 PM–4 AM: a 1 AM run is a late night)
  park_regular  one named zone visited on `park_regular_days` different days, on verified runs
Meals don't count. Park Regular reads Squirrel Dates' zone visits, which exist only for members who
opted in and only for the last KEEP_DAYS (services/dates.py); with no zones configured it is never
awarded.

Counts come from the rows themselves, never from a counter: a re-sent activity is still one
`activities` row (unique source/source_ref, and its start time never changes) and a zone visit is one
row per run and zone, so nothing counts twice. Awarding is an insert-ignore and the notification has a
dedupe key, so a retry or a concurrent ingest awards and notifies once.

Cost per activity: one query for the rule badges already held, then a count only for a badge not yet
held that this activity could complete (it started in the badge's hours, or it is a run).
"""

from __future__ import annotations

import logging
import uuid
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Activity, Badge, UserBadge, ZoneVisit
from app.schemas import BadgeProgress, BadgeStatus
from app.services import notify as notifications
from app.services.social import award_badge

log = logging.getLogger("social.badges")

EARLY_BIRD, NIGHT_OWL, PARK_REGULAR = "early_bird", "night_owl", "park_regular"
RULE_BADGES = (EARLY_BIRD, NIGHT_OWL, PARK_REGULAR)
NOT_COUNTED = ("meal",)  # logging breakfast at 6 isn't an early start


def target(badge_id: str, settings: Settings) -> int:
    return {EARLY_BIRD: settings.early_bird_activities, NIGHT_OWL: settings.night_owl_activities,
            PARK_REGULAR: settings.park_regular_days}[badge_id]


def _in_hours(badge_id: str, hour, settings: Settings):
    """Whether a local start hour counts for Early Bird / Night Owl: an int, or its SQL expression.
    Night Owl wraps midnight, ending where Early Bird begins."""
    both, either = (and_, or_) if isinstance(hour, ColumnElement) else (all_of, any_of)
    if badge_id == EARLY_BIRD:
        return both(hour >= settings.early_bird_from_hour, hour < settings.early_bird_hour)
    return either(hour >= settings.night_owl_hour, hour < settings.early_bird_from_hour)


def all_of(*conditions: bool) -> bool:
    return all(conditions)


def any_of(*conditions: bool) -> bool:
    return any(conditions)


# --------------------------------------------------------------------------- counting


def timed_activities(db: Session, user_id: uuid.UUID, badge_id: str, settings: Settings) -> int:
    """Verified activities (meals aside) that started in Early Bird's or Night Owl's local hours."""
    where = [Activity.user_id == user_id, Activity.verified.is_(True), Activity.type.not_in(NOT_COUNTED)]
    if db.get_bind().dialect.name == "postgresql":
        hour = func.extract("hour", func.timezone(settings.community_timezone, Activity.started_at))
        return int(db.scalar(select(func.count()).select_from(Activity).where(*where, _in_hours(badge_id, hour, settings))) or 0)
    # SQLite (development and tests) has no time zones: the same rule over the start times.
    tz = ZoneInfo(settings.community_timezone)
    return sum(1 for at in db.scalars(select(Activity.started_at).where(*where))
               if _in_hours(badge_id, at.astimezone(tz).hour, settings))


def zone_days(db: Session, user_id: uuid.UUID, settings: Settings) -> int:
    """The most different local days on which one configured zone was visited, on verified runs."""
    days = db.scalars(
        select(func.count(func.distinct(ZoneVisit.visited_on)))
        .join(Activity, Activity.id == ZoneVisit.activity_id)
        .where(ZoneVisit.user_id == user_id, ZoneVisit.zone_id.in_([z.id for z in settings.zones]),
               Activity.verified.is_(True))
        .group_by(ZoneVisit.zone_id)
    ).all()
    return max(days, default=0)


def progress(db: Session, user_id: uuid.UUID, badge_id: str, settings: Settings) -> int | None:
    """How far along a rule badge is; None for Park Regular while no zones are configured."""
    if badge_id == PARK_REGULAR:
        return zone_days(db, user_id, settings) if settings.zones else None
    return timed_activities(db, user_id, badge_id, settings)


# --------------------------------------------------------------------------- awarding


def after_activity(db: Session, activity: Activity, settings: Settings) -> list[str]:
    """Awards the rule badges a verified activity completes, each with a notification, in the
    caller's transaction. Call it after the run's zone visits are recorded; calling it again for a
    re-sent activity is harmless. Returns the badge ids newly awarded.

    Never fails the caller: the rules run in a savepoint, and an error is logged and dropped."""
    if not activity.verified:
        return []
    queued = len(db.info.get("pending_push", []))
    try:
        with db.begin_nested():
            return _award_due(db, activity, settings)
    except Exception:  # the activity matters more than its badge
        log.exception("badge rules failed for activity %s", activity.id)
        del db.info.get("pending_push", [])[queued:]  # pushes for notifications the savepoint undid
        return []


def _award_due(db: Session, activity: Activity, settings: Settings) -> list[str]:
    user_id = activity.user_id
    held = set(db.scalars(select(UserBadge.badge_id).where(UserBadge.user_id == user_id, UserBadge.badge_id.in_(RULE_BADGES))))
    due = []
    if activity.type not in NOT_COUNTED:
        hour = activity.started_at.astimezone(ZoneInfo(settings.community_timezone)).hour
        for badge_id in (EARLY_BIRD, NIGHT_OWL):
            if (badge_id not in held and _in_hours(badge_id, hour, settings)
                    and timed_activities(db, user_id, badge_id, settings) >= target(badge_id, settings)):
                due.append(badge_id)
    if (PARK_REGULAR not in held and settings.zones and activity.type == "run"
            and zone_days(db, user_id, settings) >= settings.park_regular_days):
        due.append(PARK_REGULAR)

    awarded = [badge_id for badge_id in due if award_badge(db, user_id, badge_id)]
    for badge_id in awarded:
        badge = db.get(Badge, badge_id)
        notifications.notify(db, user_id, "badge", f"New badge: {badge.title}", badge.description,
                             data={"route": "/profile", "badge": badge_id}, dedupe_key=f"badge:{badge_id}")
    return awarded


# --------------------------------------------------------------------------- reading


def statuses(db: Session, user_id: uuid.UUID, settings: Settings) -> list[BadgeStatus]:
    """Every catalogue badge in the app's Badge shape: unlocked or not, and for the rule badges how
    far along (a held one shows its target reached). Founding badges appear only when held: nobody
    can work towards one, so a locked one is noise."""
    rows = db.execute(
        select(Badge, UserBadge.awarded_at)
        .outerjoin(UserBadge, (UserBadge.badge_id == Badge.id) & (UserBadge.user_id == user_id))
        .order_by(Badge.id)
    ).all()
    out = []
    for badge, awarded_at in rows:
        if badge.kind == "founding" and awarded_at is None:
            continue
        steps = None
        if badge.id in RULE_BADGES:
            goal = target(badge.id, settings)
            current = goal if awarded_at else progress(db, user_id, badge.id, settings)
            steps = BadgeProgress(current=min(current, goal), target=goal) if current is not None else None
        out.append(BadgeStatus(id=badge.id, name=badge.title, description=badge.description,
                               unlocked=awarded_at is not None, unlocked_at=awarded_at, progress=steps))
    return out
