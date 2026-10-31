"""Events (meetups), RSVPs and check-ins.

  GET    /v1/events?scope=upcoming|mine|past&crew_id=&cursor=
  POST   /v1/events                          anyone can host an open event; a crew event needs a member
  GET    /v1/events/{id}
  DELETE /v1/events/{id}                     the host cancels it (everyone going is told)
  POST   /v1/events/{id}/rsvp {status}       going | interested (going is capped by capacity)
  DELETE /v1/events/{id}/rsvp
  POST   /v1/events/{id}/checkin {notify_user_ids, note}   from 1 h before the start to 6 h after
  POST   /v1/checkins {place, notify_user_ids, note}       any meetup spot: "I'm here"

A check-in may tell up to 5 friends (people who follow you, or share a crew with you). Crew members
hear about a new crew event; people going get a reminder before the start (services/reminders.py).
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from fastapi import APIRouter, Response, status
from sqlalchemy import and_, delete, func, or_, select

from app.db import utcnow
from app.deps import DB, AppSettings, CurrentViewer, Limiter, Storage
from app.errors import conflict, forbidden, invalid, not_found
from app.models import CheckIn, Crew, Event, EventRsvp
from app.pagination import clamp_limit
from app.schemas_community import (
    CheckInOut,
    CheckInRequest,
    CreateEventRequest,
    CrewRef,
    EventOut,
    EventPage,
    MeetupCheckInRequest,
    RsvpRequest,
)
from app.services import community
from app.services import notify as notifications
from app.services.social import bump

router = APIRouter(prefix="/v1", tags=["events"])

ATTENDEE_PREVIEW = 6
CHECKIN_OPENS = timedelta(hours=1)
CHECKIN_CLOSES = timedelta(hours=6)
MAX_AHEAD = timedelta(days=180)


def upcoming_events_query():
    """Events not over yet (started less than 3 h ago, or still running), soonest first."""
    now = utcnow()
    return (
        select(Event)
        .where(Event.cancelled_at.is_(None),
               or_(Event.ends_at >= now, and_(Event.ends_at.is_(None), Event.starts_at >= now - timedelta(hours=3))))
        .order_by(Event.starts_at, Event.id)
    )


def serialize_events(db, viewer_id: uuid.UUID, events: list[Event], settings, storage) -> list[EventOut]:
    if not events:
        return []
    ids = [e.id for e in events]
    rsvps = dict(db.execute(select(EventRsvp.event_id, EventRsvp.status).where(EventRsvp.user_id == viewer_id, EventRsvp.event_id.in_(ids))).all())
    checked = set(db.scalars(select(CheckIn.event_id).where(CheckIn.user_id == viewer_id, CheckIn.event_id.in_(ids))))
    ranked = (
        select(EventRsvp.event_id, EventRsvp.user_id,
               func.row_number().over(partition_by=EventRsvp.event_id, order_by=(EventRsvp.created_at, EventRsvp.user_id)).label("n"))
        .where(EventRsvp.event_id.in_(ids), EventRsvp.status == "going").subquery()
    )
    going_rows = db.execute(select(ranked.c.event_id, ranked.c.user_id).where(ranked.c.n <= ATTENDEE_PREVIEW)).all()
    crews = {c.id: c for c in db.scalars(select(Crew).where(Crew.id.in_({e.crew_id for e in events if e.crew_id})))}
    names = community.summaries(db, [u for _, u in going_rows] + [e.created_by_id for e in events], settings, storage)
    attendees: dict[uuid.UUID, list] = {}
    for event_id, user_id in going_rows:
        if user_id in names:
            attendees.setdefault(event_id, []).append(names[user_id])
    out = []
    for e in events:
        crew = crews.get(e.crew_id) if e.crew_id else None
        if e.created_by_id not in names:
            continue
        out.append(EventOut(
            id=e.id, title=e.title, description=e.description, kind=e.kind, venue=e.venue, online=e.online,
            starts_at=e.starts_at, ends_at=e.ends_at, capacity=e.capacity, going_count=e.going_count,
            cancelled=e.cancelled_at is not None,
            crew=CrewRef(id=crew.id, name=crew.name, interest=crew.interest) if crew else None,
            host=names[e.created_by_id], my_rsvp=rsvps.get(e.id), checked_in=e.id in checked,
            attendees=attendees.get(e.id, []),
        ))
    return out


def _get_event(db, event_id: uuid.UUID) -> Event:
    event = db.get(Event, event_id)
    if event is None:
        raise not_found("Event not found.")
    return event


def _one(db, viewer, event: Event, settings, storage) -> EventOut:
    return serialize_events(db, viewer.id, [event], settings, storage)[0]


@router.get("/events", response_model=EventPage)
def list_events(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, scope: str = "upcoming",
                crew_id: uuid.UUID | None = None, cursor: str | None = None, limit: int = 20):
    n = clamp_limit(limit)
    offset = int(cursor) if cursor and cursor.isdigit() else 0
    if scope == "upcoming":
        stmt = upcoming_events_query()
    elif scope == "mine":  # going, interested or hosting, still to come
        mine = select(EventRsvp.event_id).where(EventRsvp.user_id == viewer.id)
        stmt = upcoming_events_query().where((Event.id.in_(mine)) | (Event.created_by_id == viewer.id))
    elif scope == "past":
        stmt = (select(Event).where(Event.cancelled_at.is_(None), Event.starts_at < utcnow())
                .order_by(Event.starts_at.desc(), Event.id))
    else:
        raise invalid("scope must be upcoming, mine or past.")
    if crew_id:
        stmt = stmt.where(Event.crew_id == crew_id)
    events = list(db.scalars(stmt.offset(offset).limit(n + 1)))
    return EventPage(items=serialize_events(db, viewer.id, events[:n], settings, storage),
                     next_cursor=str(offset + n) if len(events) > n else None)


@router.post("/events", response_model=EventOut, status_code=status.HTTP_201_CREATED)
def create_event(body: CreateEventRequest, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    limiter.hit("event:create", str(viewer.id))
    now = utcnow()
    if body.starts_at < now - timedelta(minutes=5):
        raise invalid("The event must start in the future.", "starts_in_past")
    if body.starts_at > now + MAX_AHEAD:
        raise invalid("Events can be planned up to 6 months ahead.", "too_far_ahead")
    if body.ends_at is not None and body.ends_at <= body.starts_at:
        raise invalid("The end must be after the start.", "ends_before_start")
    crew = None
    if body.crew_id is not None:
        crew = db.get(Crew, body.crew_id)
        if crew is None:
            raise not_found("Crew not found.")
        if not community.is_member(db, crew.id, viewer.id):
            raise forbidden("Only crew members can plan a crew event.")
    event = Event(crew_id=body.crew_id, created_by_id=viewer.id, title=body.title, description=body.description,
                  kind=body.kind, venue=body.venue, online=body.online, starts_at=body.starts_at, ends_at=body.ends_at,
                  capacity=body.capacity, going_count=1, created_at=now)
    db.add(event)
    db.flush()
    db.add(EventRsvp(event_id=event.id, user_id=viewer.id, status="going", created_at=now))
    if crew is not None:
        notifications.notify(db, community.crew_member_ids(db, crew.id), "event_new", f"New {crew.name} event: {event.title}",
                             _when(event, settings), data={"route": f"/event/{event.id}", "event_id": str(event.id)},
                             actor_id=viewer.id, dedupe_key=f"event_new:{event.id}")
    db.commit()
    return _one(db, viewer, event, settings, storage)


def _when(event: Event, settings) -> str:
    local = event.starts_at.astimezone(community.zone(settings))
    where = "online" if event.online else (event.venue or "")
    return f"{local:%a %d %b, %H:%M}" + (f" · {where}" if where else "")


@router.get("/events/{event_id}", response_model=EventOut)
def get_event(event_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    return _one(db, viewer, _get_event(db, event_id), settings, storage)


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_event(event_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings):
    event = _get_event(db, event_id)
    if event.created_by_id != viewer.id:
        raise forbidden("Only the host can cancel this event.")
    if event.cancelled_at is None:
        event.cancelled_at = utcnow()
        going = db.scalars(select(EventRsvp.user_id).where(EventRsvp.event_id == event.id)).all()
        notifications.notify(db, going, "event_cancelled", f"Cancelled: {event.title}", _when(event, settings),
                             data={"route": f"/event/{event.id}", "event_id": str(event.id)}, actor_id=viewer.id,
                             dedupe_key=f"event_cancelled:{event.id}")
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/events/{event_id}/rsvp", response_model=EventOut)
def rsvp(event_id: uuid.UUID, body: RsvpRequest, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    limiter.hit("rsvp", str(viewer.id))
    event = _get_event(db, event_id)
    if event.cancelled_at is not None:
        raise conflict("This event was cancelled.", "event_cancelled")
    current = db.get(EventRsvp, (event.id, viewer.id))
    was_going = current is not None and current.status == "going"
    if body.status == "going" and not was_going and event.capacity is not None and event.going_count >= event.capacity:
        raise conflict("This event is full.", "event_full")
    if current is None:
        db.add(EventRsvp(event_id=event.id, user_id=viewer.id, status=body.status, created_at=utcnow()))
    else:
        current.status = body.status
    delta = (body.status == "going") - was_going
    if delta:
        bump(db, Event, Event.id == event.id, going_count=delta)
    db.commit()
    db.refresh(event)
    return _one(db, viewer, event, settings, storage)


@router.delete("/events/{event_id}/rsvp", response_model=EventOut)
def cancel_rsvp(event_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    event = _get_event(db, event_id)
    current = db.get(EventRsvp, (event.id, viewer.id))
    if current is not None:
        if current.status == "going":
            bump(db, Event, Event.id == event.id, going_count=-1)
        db.execute(delete(EventRsvp).where(EventRsvp.event_id == event.id, EventRsvp.user_id == viewer.id))
        db.commit()
        db.refresh(event)
    return _one(db, viewer, event, settings, storage)


def _check_in(db, viewer, *, place: str, event: Event | None, body: CheckInRequest) -> CheckIn:
    friends = community.friends_among(db, viewer.id, body.notify_user_ids)
    checkin = CheckIn(user_id=viewer.id, event_id=event.id if event else None, place=place, note=body.note or "",
                      notified_count=len(friends), created_at=utcnow())
    db.add(checkin)
    db.flush()
    if friends:
        title = f"{viewer.user.display_name} checked in at {place}"
        notifications.notify(db, friends, "checkin", title, body.note or "",
                             data={"route": f"/user/{viewer.id}", "checkin_id": str(checkin.id),
                                   **({"event_id": str(event.id)} if event else {})},
                             actor_id=viewer.id, dedupe_key=f"checkin:{checkin.id}")
    db.commit()
    return checkin


def _checkin_out(c: CheckIn) -> CheckInOut:
    return CheckInOut(id=c.id, place=c.place, event_id=c.event_id, note=c.note, notified=c.notified_count, created_at=c.created_at)


@router.post("/events/{event_id}/checkin", response_model=CheckInOut, status_code=status.HTTP_201_CREATED)
def event_check_in(event_id: uuid.UUID, body: CheckInRequest, db: DB, viewer: CurrentViewer, limiter: Limiter):
    limiter.hit("checkin", str(viewer.id))
    event = _get_event(db, event_id)
    now = utcnow()
    if event.cancelled_at is not None:
        raise conflict("This event was cancelled.", "event_cancelled")
    if not (event.starts_at - CHECKIN_OPENS <= now <= (event.ends_at or event.starts_at) + CHECKIN_CLOSES):
        raise conflict("Check-in opens an hour before the event starts.", "checkin_closed")
    existing = db.scalar(select(CheckIn).where(CheckIn.event_id == event.id, CheckIn.user_id == viewer.id))
    if existing is not None:
        return _checkin_out(existing)
    place = event.venue or event.title
    return _checkin_out(_check_in(db, viewer, place=place[:80], event=event, body=body))


@router.post("/checkins", response_model=CheckInOut, status_code=status.HTTP_201_CREATED)
def meetup_check_in(body: MeetupCheckInRequest, db: DB, viewer: CurrentViewer, limiter: Limiter):
    limiter.hit("checkin", str(viewer.id))
    return _checkin_out(_check_in(db, viewer, place=body.place, event=None, body=body))
