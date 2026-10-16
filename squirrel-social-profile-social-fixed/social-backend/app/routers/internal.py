"""Service-to-service routes — how the other modules publish into Social.

  POST /internal/v1/activities              Authorization: Bearer $SOCIAL_INTERNAL_TOKEN
  POST /internal/v1/notifications           a territory event (Run Module), a campus event (campus-service)
                                            or a Partner Hunt request/accept (Exercise)
                                            → the in-app list + push; returns Social's notification id
  POST /internal/v1/tasks/push-receipts     check Expo push receipts now (for an external cron)
  POST /internal/v1/tasks/event-reminders   send due event reminders now (for an external cron)
  POST /internal/v1/tasks/ambassador-rewards grant due referral rewards, retry pending XP awards/reversals
  POST /internal/v1/people/resolve          token subjects / profile ids → Social names, profile ids,
                                            avatar, hostel, level (campus-service); unseen subjects
                                            are provisioned like a first sign-in
  GET  /internal/v1/blocks/{subject}        everyone blocked either way with that person, by subject
                                            (campus-service: Nearby, map, meetups); never writes
  POST /internal/v1/blocks/import           one-time copy of another service's own blocks into Social
  POST /internal/v1/crews/memberships       subjects → their crews (campus-service: crew territory)
  POST /internal/v1/crews/lookup            crew ids → crew + members by subject
  GET  /internal/v1/crews/count             how many crews have at least one member (campus stats)

The Run Module's finish worker (or the Exercise backend) calls this once an activity is final.
It is idempotent on (source, source_ref): re-sending the same run returns the same activity, with
its summary (name, distance, duration, calories, metrics) updated to the latest one sent. The
Exercise backend re-sends a workout after each set, so the profile shows the finished session.
The activity counts toward the activity badges (services/badges.py), then shows in the owner's
profile and can be shared with
POST /v1/posts { activity: { source: "activity", activity_id } }. Never exposed to the app.
"""

from __future__ import annotations

import hmac
import re
import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Request, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError

from app.auth import bearer_token, get_or_create_user
from app.db import utcnow
from app.deps import DB, AppSettings, Storage
from app.errors import ApiError, conflict
from app.models import Activity, AmbassadorProfile, Crew, CrewMember, Notification, User, UserBlock, UserStats
from app.schemas import InternalActivityOut, InternalActivityIn
from app.schemas_community import (
    InternalBlocksImportIn,
    InternalBlocksImportOut,
    InternalBlocksOut,
    InternalCrew,
    InternalCrewMember,
    InternalCrewMemberships,
    InternalCrewMembershipsIn,
    InternalCrewMembershipsOut,
    InternalCrewRef,
    InternalCrewsCountOut,
    InternalCrewsLookupIn,
    InternalCrewsLookupOut,
    InternalNotificationIn,
    InternalNotificationOut,
    InternalPeopleResolveIn,
    InternalPeopleResolveOut,
    InternalPerson,
    RUN_MODULE_KINDS,
)
from app.services import notify as notifications
from app.services import ambassador, badges, dates, reminders, social, xp_cache
from app.routers.follows import _unfollow
from app.services.social import insert_ignore

router = APIRouter(prefix="/internal/v1", tags=["internal"], include_in_schema=False)


def _check_service_token(settings, authorization: str | None) -> None:
    if not settings.internal_token:
        raise ApiError(404, "not_found", "Not found")
    token = bearer_token(authorization)
    if not hmac.compare_digest(token.encode(), settings.internal_token.encode()):
        raise ApiError(401, "unauthorized", "Invalid service token.", {"WWW-Authenticate": "Bearer"})


@router.post("/activities", response_model=InternalActivityOut)
def ingest_activity(
    body: InternalActivityIn,
    request: Request,
    response: Response,
    db: DB,
    settings: AppSettings,
    authorization: Annotated[str | None, Header()] = None,
):
    _check_service_token(settings, authorization)
    user = get_or_create_user(db, body.user_subject)
    existing = db.scalar(select(Activity).where(Activity.source == body.source, Activity.source_ref == body.source_ref))
    if existing:
        if existing.user_id != user.id:
            raise conflict("source_ref already belongs to another user.")
        _update_summary(existing, body)
        dates.record_visits(db, existing, settings, request.app.state.route_points)
        badges.after_activity(db, existing, settings)  # counts from rows: a re-send never counts twice
        db.commit()
        return InternalActivityOut(activity_id=existing.id, created=False)
    activity = Activity(
        user_id=user.id,
        type=body.type,
        source=body.source,
        source_ref=body.source_ref,
        verified=True,  # measured by the publishing module
        name=body.name,
        distance_m=body.distance_m,
        duration_s=body.duration_s,
        calories=body.calories,
        metrics=body.metrics,
        started_at=body.started_at,
        created_at=utcnow(),
    )
    db.add(activity)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Activity).where(Activity.source == body.source, Activity.source_ref == body.source_ref))
        if existing and existing.user_id == user.id:
            _update_summary(existing, body)
            db.commit()
            return InternalActivityOut(activity_id=existing.id, created=False)
        raise conflict("source_ref already belongs to another user.") from None
    social.after_activity_recorded(db, activity, settings)
    # A referred friend's first activity may make their ambassador's referral reward due.
    ambassador.after_activity(db, activity)
    # Squirrel Dates: which named zones the run passed (opted-in runners only; never fails the ingest).
    dates.record_visits(db, activity, settings, request.app.state.route_points)
    # Early Bird, Night Owl, Park Regular (after the visits; never fails the ingest either).
    badges.after_activity(db, activity, settings)
    db.commit()
    response.status_code = status.HTTP_201_CREATED
    return InternalActivityOut(activity_id=activity.id, created=True)


def _update_summary(activity: Activity, body: InternalActivityIn) -> None:
    """A re-sent activity carries its latest summary; its identity (owner, source, type) stays."""
    activity.name = body.name
    activity.distance_m = body.distance_m
    activity.duration_s = body.duration_s
    activity.calories = body.calories
    activity.metrics = body.metrics


def _area(data: dict) -> str:
    value = data.get("area_delta_m2")
    if not isinstance(value, (int, float)) or value <= 0:
        return ""
    return f"{value / 1_000_000:.2f} km²" if value >= 100_000 else f"{round(value):,} m²"


def _territory_text(kind: str, actor: User | None, data: dict) -> tuple[str, str]:
    area = _area(data)
    if kind == "territory_lost":
        who = actor.display_name if actor else "Someone"
        return f"{who} stole your territory", (f"{area} taken. " if area else "") + "Run it back!"
    if kind == "territory_captured":
        n = data.get("territories_taken")
        n = n if isinstance(n, int) and n > 1 else 1
        return (f"You captured {n} territories" if n > 1 else "You captured territory"), (f"{area} is yours now." if area else "")
    return "Your territory faded", "Run there again to claim it back."


# Fields that identify the actor or point at their own run: dropped when the actor is hidden.
_ACTOR_DATA = {"run_id", "capture_event_id", "user_id", "actor_id", "actor_subject"}

# Where a tap opens when the caller sends no `data.route` (app screens, see mobile src/app/).
_ROUTES = {"territory": "/territory", "zone": "/territory", "challenge": "/invites", "event": "/events",
           "meetup": "/meetups", "activity": "/notifications", "partner": "/partner-hunt", "xp": "/progress",
           "shared_workout": "/workout", "bubble": "/bubble"}
_PATH_SAFE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _route(kind: str, data: dict) -> str:
    if kind in RUN_MODULE_KINDS:
        return "/territory"
    prefix = kind.split(".", 1)[0]
    if prefix == "meetup" and isinstance(data.get("meetup_id"), str):
        return f"/meetup/{data['meetup_id']}"
    if prefix in ("territory", "zone") and isinstance(data.get("zone_id"), str):
        return f"/zone/{data['zone_id']}"
    if kind == "shared_workout.invited" and _PATH_SAFE.match(str(data.get("code", ""))):
        return f"/workout/join/{data['code']}"
    if kind == "shared_workout.finished" and _PATH_SAFE.match(str(data.get("session_id", ""))):
        return f"/workout/{data['session_id']}"
    return _ROUTES[prefix]


def _fill_actor(text: str, actor: User | None, fallback: str) -> str:
    """`{actor}` → the actor's name; plain replace, so nothing else in the text is interpreted."""
    return text.replace("{actor}", actor.display_name if actor else fallback)


@router.post("/notifications", response_model=InternalNotificationOut)
def ingest_notification(
    body: InternalNotificationIn,
    db: DB,
    settings: AppSettings,
    authorization: Annotated[str | None, Header()] = None,
):
    _check_service_token(settings, authorization)
    user = get_or_create_user(db, body.user_subject)
    actor = None
    if body.actor_subject and body.actor_subject != body.user_subject:
        actor = db.scalar(select(User).where(User.auth_subject == body.actor_subject))
    data = {k: v for k, v in body.data.items() if isinstance(v, (str, int, float, bool)) and len(str(v)) <= 100}
    if actor and dates.is_blocked(db, user.id, actor.id):
        # Blocked either way: the notification still arrives, but never says who, or which run.
        actor = None
        data = {k: v for k, v in data.items() if k not in _ACTOR_DATA}
    if body.kind in RUN_MODULE_KINDS:
        title, text = _territory_text(body.kind, actor, body.data)
    else:
        title = _fill_actor(body.title or "", actor, body.actor_fallback)
        text = _fill_actor(body.body or "", actor, body.actor_fallback)
    if not (isinstance(data.get("route"), str) and data["route"].startswith("/")):
        data["route"] = _route(body.kind, data)
    created = notifications.notify(db, user.id, body.kind, title, text, data=data,
                                   actor_id=actor.id if actor else None, dedupe_key=body.dedupe_key)
    db.commit()
    notification_id = db.scalar(select(Notification.id).where(
        Notification.user_id == user.id, Notification.dedupe_key == body.dedupe_key))
    return InternalNotificationOut(created=created > 0, notification_id=notification_id)


@router.post("/tasks/event-reminders")
def run_event_reminders(
    db: DB,
    settings: AppSettings,
    authorization: Annotated[str | None, Header()] = None,
):
    _check_service_token(settings, authorization)
    return {"reminded_events": reminders.send_due(db, settings)}


@router.post("/tasks/ambassador-rewards")
def run_ambassador_rewards(
    request: Request,
    db: DB,
    settings: AppSettings,
    authorization: Annotated[str | None, Header()] = None,
):
    """Grants referral rewards still due (e.g. held back by the daily limit) and retries awards and
    reversals the Run Module hasn't confirmed (for an external cron)."""
    _check_service_token(settings, authorization)
    for (ambassador_id,) in db.execute(select(AmbassadorProfile.user_id).where(AmbassadorProfile.status == "active")).all():
        ambassador.sweep(db, ambassador_id)
    db.commit()
    return {"settled": ambassador.settle(db, request.app.state.run_module, settings)}


@router.post("/tasks/push-receipts")
def run_push_receipts(
    request: Request,
    settings: AppSettings,
    authorization: Annotated[str | None, Header()] = None,
):
    _check_service_token(settings, authorization)
    check = getattr(request.app.state.push, "check_receipts", None)
    return {"receipts_read": check() if check else 0}


@router.post("/people/resolve", response_model=InternalPeopleResolveOut)
def resolve_people(
    body: InternalPeopleResolveIn,
    db: DB,
    settings: AppSettings,
    storage: Storage,
    authorization: Annotated[str | None, Header()] = None,
):
    """Token subjects and/or public profile ids → one row per person, in request order (subjects
    first), each person once. Every subject comes back: one Social has never seen gets its profile
    now, as on a first sign-in. Unknown profile ids are left out. A fixed number of queries,
    plus one provisioning round per genuinely new subject."""
    _check_service_token(settings, authorization)
    subjects = list(dict.fromkeys(body.subjects))
    profile_ids = list(dict.fromkeys(body.profile_ids))
    if not subjects and not profile_ids:
        return InternalPeopleResolveOut(people=[])

    def load() -> list[tuple[User, int]]:
        where = []
        if subjects:
            where.append(User.auth_subject.in_(subjects))
        if profile_ids:
            where.append(User.id.in_(profile_ids))
        return db.execute(
            select(User, func.coalesce(UserStats.xp, 0))
            .outerjoin(UserStats, UserStats.user_id == User.id)
            .where(or_(*where))
        ).all()

    rows = load()
    seen = {u.auth_subject for u, _ in rows}
    new = [s for s in subjects if s not in seen]
    if new:
        for subject in new:
            get_or_create_user(db, subject)
        rows = load()

    urls = social.media_urls(db, storage, [u.avatar_media_id for u, _ in rows])
    # Provisioning (if any) has committed: nothing here is half done, so the refresh may commit.
    xp_now = xp_cache.fresh(db, [u.id for u, _ in rows], settled=True)
    rows = [(u, xp_now.get(u.id, xp)) for u, xp in rows]
    by_subject = {u.auth_subject: (u, xp) for u, xp in rows}
    by_id = {u.id: (u, xp) for u, xp in rows}
    ordered = [by_subject[s] for s in subjects if s in by_subject] + [by_id[i] for i in profile_ids if i in by_id]
    people, emitted = [], set()
    for user, xp in ordered:
        if user.id in emitted:
            continue
        emitted.add(user.id)
        people.append(InternalPerson(
            subject=user.auth_subject,
            profile_id=user.id,
            username=user.username,
            display_name=user.display_name,
            avatar_url=urls.get(user.avatar_media_id),
            hostel=user.hostel,
            level=social.level_for(xp, settings),
        ))
    return InternalPeopleResolveOut(people=people)


@router.get("/blocks/{subject}", response_model=InternalBlocksOut)
def blocks_for(
    subject: str,
    db: DB,
    settings: AppSettings,
    authorization: Annotated[str | None, Header()] = None,
):
    """Who `subject` blocked plus who blocked them, as subjects. A subject Social has never seen
    has no blocks (and is not provisioned: this read never writes). Blocking is Social's
    (ADR-032); the caller caches the answer for at most 30 seconds."""
    _check_service_token(settings, authorization)
    as_of = utcnow()
    me = db.scalar(select(User.id).where(User.auth_subject == subject))
    others = dates.blocked_either_way(db, me) if me else set()
    blocked = db.scalars(select(User.auth_subject).where(User.id.in_(others)).order_by(User.auth_subject)).all() if others else []
    return InternalBlocksOut(subject=subject, blocked=list(blocked), as_of=as_of)


@router.post("/blocks/import", response_model=InternalBlocksImportOut)
def import_blocks(
    body: InternalBlocksImportIn,
    db: DB,
    settings: AppSettings,
    authorization: Annotated[str | None, Header()] = None,
):
    """Copies blocks a service kept in its own table, so Social's list is the whole truth before
    that table is dropped. Safe to re-run: a pair already blocked is counted, not duplicated.
    People Social hasn't seen yet get their profile now, as on a first sign-in, so no block is lost.
    Follows between the two are removed, as when blocking in the app."""
    _check_service_token(settings, authorization)
    imported = already = skipped = 0
    users: dict[str, User] = {}
    for pair in body.blocks:
        if pair.blocker == pair.blocked:
            skipped += 1
            continue
        for sub in (pair.blocker, pair.blocked):
            if sub not in users:
                users[sub] = get_or_create_user(db, sub)
        a, b = users[pair.blocker].id, users[pair.blocked].id
        if insert_ignore(db, UserBlock, {"blocker_id": a, "blocked_id": b, "created_at": utcnow()}):
            imported += 1
            _unfollow(db, a, b)
            _unfollow(db, b, a)
        else:
            already += 1
    db.commit()
    return InternalBlocksImportOut(imported=imported, already=already, skipped=skipped)


@router.post("/crews/memberships", response_model=InternalCrewMembershipsOut)
def crew_memberships(
    body: InternalCrewMembershipsIn,
    db: DB,
    settings: AppSettings,
    authorization: Annotated[str | None, Header()] = None,
):
    """Each subject's crews, oldest membership first (so the first is their main crew), one row per
    subject in request order. Never writes: a subject Social hasn't seen has no crews."""
    _check_service_token(settings, authorization)
    subjects = list(dict.fromkeys(body.subjects))
    rows = db.execute(
        select(User.auth_subject, Crew.id, Crew.name, CrewMember.role, CrewMember.joined_at)
        .join(CrewMember, CrewMember.user_id == User.id)
        .join(Crew, Crew.id == CrewMember.crew_id)
        .where(User.auth_subject.in_(subjects))
        .order_by(CrewMember.joined_at, Crew.id)
    ).all()
    crews: dict[str, list[InternalCrewRef]] = {s: [] for s in subjects}
    for subject, crew_id, name, role, joined_at in rows:
        crews[subject].append(InternalCrewRef(id=crew_id, name=name, role=role, joined_at=joined_at))
    return InternalCrewMembershipsOut(people=[InternalCrewMemberships(subject=s, crews=crews[s]) for s in subjects])


@router.post("/crews/lookup", response_model=InternalCrewsLookupOut)
def crews_lookup(
    body: InternalCrewsLookupIn,
    db: DB,
    settings: AppSettings,
    authorization: Annotated[str | None, Header()] = None,
):
    """Crews by id with their members as subjects (oldest first). Unknown ids are left out, so
    "no such crew" is a missing entry, never a 404."""
    _check_service_token(settings, authorization)
    ids = list(dict.fromkeys(body.crew_ids))
    found = {c.id: c for c in db.scalars(select(Crew).where(Crew.id.in_(ids)))}
    members: dict[uuid.UUID, list[InternalCrewMember]] = {i: [] for i in found}
    if found:
        for crew_id, subject, role, joined_at in db.execute(
            select(CrewMember.crew_id, User.auth_subject, CrewMember.role, CrewMember.joined_at)
            .join(User, User.id == CrewMember.user_id)
            .where(CrewMember.crew_id.in_(list(found)))
            .order_by(CrewMember.joined_at, User.auth_subject)
        ):
            members[crew_id].append(InternalCrewMember(subject=subject, role=role, joined_at=joined_at))
    return InternalCrewsLookupOut(crews=[
        InternalCrew(id=c.id, name=c.name, interest=c.interest, scope=c.scope, hostel=c.hostel,
                     members_count=c.members_count, members=members[c.id])
        for i in ids if (c := found.get(i))
    ])


@router.get("/crews/count", response_model=InternalCrewsCountOut)
def crews_count(db: DB, settings: AppSettings, authorization: Annotated[str | None, Header()] = None):
    """Crews with at least one member, counted from the membership rows: a crew left empty (its
    last member's account deleted) doesn't count, whatever its stored members_count says."""
    _check_service_token(settings, authorization)
    total = db.scalar(select(func.count(func.distinct(CrewMember.crew_id)))) or 0
    return InternalCrewsCountOut(crews_total=total, as_of=utcnow())
