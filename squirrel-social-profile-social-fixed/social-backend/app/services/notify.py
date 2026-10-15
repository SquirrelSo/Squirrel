"""Notifications: one row in the in-app list per recipient, plus a push to each of their devices
(services/push.py, sent after the request commits). Social is the only notification store: the
other services post theirs to POST /internal/v1/notifications, which lands here too.

`dedupe_key` makes a notification land at most once per user, so a retried delivery (the Run
Module re-sends until it gets a 2xx) cannot double-notify. `data.route` is the app screen a tap
opens.

Every kind belongs to a preference category (`category_for`, CONTRACT §2). Per recipient:

* in-app off for the category → nothing is stored (and nothing pushed). `system` is never muted.
* push off for the category, or inside their quiet hours → stored in-app only, no push.
* more than PUSH_LIMIT pushes of one category in PUSH_WINDOW → stored in-app silently (a simple
  batching measure: a burst of likes doesn't buzz the phone twenty times).
* some kinds may only arrive once per MIN_INTERVAL (campus's `bubble.activity`: once per 6 h).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import Notification, NotificationPreference, PushToken, User
from app.services import push
from app.services.social import insert_ignore

CATEGORIES: tuple[str, ...] = ("xp", "challenges", "territory", "buddies", "workouts", "meetups", "bubble",
                               "crews", "ambassador", "social", "system")
UNMUTABLE = frozenset({"system"})

PUSH_LIMIT = 6
PUSH_WINDOW = timedelta(hours=1)
MIN_INTERVAL: dict[str, timedelta] = {"bubble.activity": timedelta(hours=6)}

# (prefix, category), first match wins: territory.challenged is a challenge, not territory.
_CATEGORY_RULES: tuple[tuple[str, str], ...] = (
    ("system", "system"),
    ("xp", "xp"), ("badge", "xp"),
    ("territory.challenged", "challenges"), ("challenge", "challenges"), ("duel", "challenges"),
    ("territory", "territory"), ("zone", "territory"),
    ("partner", "buddies"),
    ("shared_workout", "workouts"),
    ("meetup", "meetups"), ("event", "meetups"), ("checkin", "meetups"),
    ("bubble", "bubble"),
    ("crew", "crews"), ("vouch", "crews"),
    ("ambassador", "ambassador"),
    ("follow", "social"), ("referral", "social"), ("like", "social"), ("comment", "social"),
)


def category_for(kind: str) -> str:
    for prefix, category in _CATEGORY_RULES:
        if kind == prefix or kind.startswith(prefix):
            return category
    return "social"


# --------------------------------------------------------------------------- preferences


def default_categories() -> dict[str, dict[str, bool]]:
    return {c: {"push": True, "in_app": True} for c in CATEGORIES}


def effective_categories(pref: NotificationPreference | None) -> dict[str, dict[str, bool]]:
    out = default_categories()
    stored = (pref.categories if pref else None) or {}
    for c in CATEGORIES:
        if c in UNMUTABLE:
            continue
        entry = stored.get(c)
        if isinstance(entry, dict):
            for channel in ("push", "in_app"):
                if isinstance(entry.get(channel), bool):
                    out[c][channel] = entry[channel]
    return out


def update_preferences(db: Session, user_id: uuid.UUID, default_timezone: str, *,
                       categories: dict[str, dict[str, bool]] | None = None,
                       quiet_hours: tuple[int | None, int | None] | None = None,
                       timezone: str | None = None) -> NotificationPreference:
    """Applies a validated change (routers check `system` and the quiet-hour pair first)."""
    pref = db.get(NotificationPreference, user_id)
    if pref is None:
        pref = NotificationPreference(user_id=user_id, categories={}, timezone=default_timezone, updated_at=utcnow())
        db.add(pref)
    if categories:
        merged = {k: dict(v) for k, v in (pref.categories or {}).items() if k in CATEGORIES}
        for c, channels in categories.items():
            merged.setdefault(c, {}).update(channels)
        pref.categories = merged  # a new dict: JSON columns only notice reassignment
    if quiet_hours is not None:
        pref.quiet_hours_start, pref.quiet_hours_end = quiet_hours
    if timezone is not None:
        pref.timezone = timezone
    pref.updated_at = utcnow()
    db.flush()
    return pref


def in_quiet_hours(pref: NotificationPreference | None, now: datetime) -> bool:
    if pref is None or pref.quiet_hours_start is None or pref.quiet_hours_end is None:
        return False
    try:
        local = now.astimezone(ZoneInfo(pref.timezone))
    except (ZoneInfoNotFoundError, ValueError):
        return False
    minute = local.hour * 60 + local.minute
    start, end = pref.quiet_hours_start, pref.quiet_hours_end
    if start == end:
        return False
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end  # wraps midnight, e.g. 22:00–07:00


# --------------------------------------------------------------------------- notify


def notify(
    db: Session,
    user_ids: uuid.UUID | Iterable[uuid.UUID],
    kind: str,
    title: str,
    body: str = "",
    *,
    data: dict | None = None,
    actor_id: uuid.UUID | None = None,
    dedupe_key: str | None = None,
    now: datetime | None = None,
) -> int:
    """Notify one user or several. Returns how many notifications were stored (duplicates by
    `dedupe_key`, muted categories and too-frequent kinds are skipped). Never notifies the actor
    about their own action."""
    ids = [user_ids] if isinstance(user_ids, uuid.UUID) else list(dict.fromkeys(user_ids))
    ids = [i for i in ids if i != actor_id]
    if not ids:
        return 0
    title, body, data = title[:120], body[:240], dict(data or {})
    now = now or utcnow()
    category = category_for(kind)
    prefs = {p.user_id: p for p in db.scalars(select(NotificationPreference).where(NotificationPreference.user_id.in_(ids)))}

    if category not in UNMUTABLE:
        ids = [i for i in ids if effective_categories(prefs.get(i))[category]["in_app"]]
    if kind in MIN_INTERVAL and ids:
        recent = set(db.scalars(select(Notification.user_id).where(
            Notification.user_id.in_(ids), Notification.kind == kind, Notification.created_at > now - MIN_INTERVAL[kind])))
        ids = [i for i in ids if i not in recent]
    if not ids:
        return 0

    pushes_recent = dict(db.execute(
        select(Notification.user_id, func.count()).where(
            Notification.user_id.in_(ids), Notification.category == category, Notification.pushed.is_(True),
            Notification.created_at > now - PUSH_WINDOW)
        .group_by(Notification.user_id)
    ).all())
    with_tokens = set(db.scalars(select(PushToken.user_id).where(PushToken.user_id.in_(ids), PushToken.disabled_at.is_(None))))

    def should_push(user_id: uuid.UUID) -> bool:
        pref = prefs.get(user_id)
        if user_id not in with_tokens:
            return False
        if category not in UNMUTABLE and not effective_categories(pref)[category]["push"]:
            return False
        if in_quiet_hours(pref, now):
            return False
        return pushes_recent.get(user_id, 0) < PUSH_LIMIT

    pushed: list[uuid.UUID] = []
    created = 0
    for user_id in ids:
        send = should_push(user_id)
        values = {"id": uuid.uuid4(), "user_id": user_id, "kind": kind, "title": title, "body": body, "data": data,
                  "actor_id": actor_id, "dedupe_key": dedupe_key, "created_at": now, "read_at": None,
                  "category": category, "pushed": send}
        if dedupe_key is None:
            db.add(Notification(**values))
        elif not insert_ignore(db, Notification, values):
            continue
        created += 1
        if send:
            pushed.append(user_id)
    if pushed:
        tokens = db.execute(
            select(PushToken.token).where(PushToken.user_id.in_(pushed), PushToken.disabled_at.is_(None))
        ).scalars().all()
        push.queue(db, [
            {"to": token, "title": title, "body": body, "sound": "default", "data": {"kind": kind, **data}}
            for token in tokens
        ])
    return created


ANNOUNCEMENT_BATCH = 500


def announce(db: Session, announcement_id: uuid.UUID, title: str, body: str, route: str) -> int:
    """`system.announcement` to every user, ANNOUNCEMENT_BATCH at a time (one commit each, so a huge
    audience never holds one long transaction). Keyed by the announcement id: re-running it after a
    failure finishes the job without notifying anyone twice."""
    total = 0
    last: uuid.UUID | None = None
    while True:
        stmt = select(User.id).order_by(User.id).limit(ANNOUNCEMENT_BATCH)
        if last is not None:
            stmt = stmt.where(User.id > last)
        batch = list(db.scalars(stmt))
        if not batch:
            return total
        total += notify(db, batch, "system.announcement", title, body, data={"route": route, "announcement_id": str(announcement_id)},
                        dedupe_key=f"announcement:{announcement_id}")
        db.commit()
        last = batch[-1]
