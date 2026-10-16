"""Crews: create, list, join, leave, and vouching between members.

  GET    /v1/crews?mine=&q=&cursor=              biggest first (or mine, newest joined first)
  POST   /v1/crews                               create one; you are its owner and first member
  GET    /v1/crews/{id}                          detail: members (member since, vouches), upcoming events
  POST   /v1/crews/{id}/join
  DELETE /v1/crews/{id}/membership               leave (an owner hands the crew to the longest-standing
                                                 member; the last one out deletes it)
  POST   /v1/crews/{id}/members/{user_id}/vouch  "I've trained with them" (members only, not yourself)
  DELETE /v1/crews/{id}/members/{user_id}/vouch
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app.db import utcnow
from app.deps import DB, AppSettings, CurrentViewer, Limiter, Storage
from app.errors import conflict, forbidden, invalid, not_found
from app.models import Crew, CrewMember, CrewVouch, Event
from app.pagination import clamp_limit
from app.schemas_community import CreateCrewRequest, CrewDetail, CrewMemberOut, CrewOut, CrewPage, VouchResult
from app.services import community
from app.services import notify as notifications
from app.services.social import bump, insert_ignore
from app.routers.events import serialize_events, upcoming_events_query

router = APIRouter(prefix="/v1/crews", tags=["crews"])

PREVIEW = 5


def _get_crew(db, crew_id: uuid.UUID) -> Crew:
    crew = db.get(Crew, crew_id)
    if crew is None:
        raise not_found("Crew not found.")
    return crew


def serialize_crews(db, viewer_id, crews: list[Crew], settings, storage) -> list[CrewOut]:
    if not crews:
        return []
    ids = [c.id for c in crews]
    mine = {m.crew_id: m for m in db.scalars(select(CrewMember).where(CrewMember.user_id == viewer_id, CrewMember.crew_id.in_(ids)))}
    # A few members per crew for the avatar row: the earliest to join.
    ranked = (
        select(CrewMember.crew_id, CrewMember.user_id,
               func.row_number().over(partition_by=CrewMember.crew_id, order_by=(CrewMember.joined_at, CrewMember.user_id)).label("n"))
        .where(CrewMember.crew_id.in_(ids)).subquery()
    )
    preview_rows = db.execute(select(ranked.c.crew_id, ranked.c.user_id).where(ranked.c.n <= PREVIEW)).all()
    names = community.summaries(db, [u for _, u in preview_rows], settings, storage)
    previews: dict[uuid.UUID, list] = {}
    for crew_id, user_id in preview_rows:
        if user_id in names:
            previews.setdefault(crew_id, []).append(names[user_id])
    return [
        CrewOut(
            id=c.id, name=c.name, tagline=c.tagline, interest=c.interest, meets=c.meets, scope=c.scope, hostel=c.hostel,
            members_count=c.members_count, created_at=c.created_at, is_member=c.id in mine,
            my_role=mine[c.id].role if c.id in mine else None,
            member_since=mine[c.id].joined_at if c.id in mine else None, preview=previews.get(c.id, []),
        )
        for c in crews
    ]


@router.get("", response_model=CrewPage)
def list_crews(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, mine: bool = False,
               q: str | None = None, cursor: str | None = None, limit: int = 20):
    n = clamp_limit(limit)
    offset = int(cursor) if cursor and cursor.isdigit() else 0
    stmt = select(Crew)
    if mine:
        stmt = stmt.join(CrewMember, (CrewMember.crew_id == Crew.id) & (CrewMember.user_id == viewer.id)).order_by(CrewMember.joined_at.desc(), Crew.id)
    else:
        stmt = stmt.order_by(Crew.members_count.desc(), Crew.created_at.desc(), Crew.id)
    term = (q or "").strip().lower()
    if term:
        escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        stmt = stmt.where(Crew.name_key.like(f"%{escaped}%", escape="\\"))
    crews = list(db.scalars(stmt.offset(offset).limit(n + 1)))
    page = crews[:n]
    return CrewPage(items=serialize_crews(db, viewer.id, page, settings, storage),
                    next_cursor=str(offset + n) if len(crews) > n else None)


@router.post("", response_model=CrewDetail, status_code=status.HTTP_201_CREATED)
def create_crew(body: CreateCrewRequest, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    limiter.hit("crew:create", str(viewer.id))
    if body.hostel is not None and body.hostel not in settings.hostels:
        raise invalid("Pick one of the listed hostels.", "invalid_hostel")
    now = utcnow()
    crew = Crew(name=body.name, name_key=body.name.lower(), tagline=body.tagline, interest=body.interest, meets=body.meets,
                scope=body.scope, hostel=body.hostel, created_by_id=viewer.id, members_count=1, created_at=now)
    db.add(crew)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise conflict("A crew with that name already exists.", "crew_name_taken") from None
    db.add(CrewMember(crew_id=crew.id, user_id=viewer.id, role="owner", joined_at=now))
    db.commit()
    return crew_detail(crew.id, db, viewer, settings, storage)


@router.get("/{crew_id}", response_model=CrewDetail)
def crew_detail(crew_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    crew = _get_crew(db, crew_id)
    base = serialize_crews(db, viewer.id, [crew], settings, storage)[0]
    members = db.execute(
        select(CrewMember).where(CrewMember.crew_id == crew.id).order_by(CrewMember.joined_at, CrewMember.user_id).limit(200)
    ).scalars().all()
    vouches = dict(db.execute(
        select(CrewVouch.vouchee_id, func.count()).where(CrewVouch.crew_id == crew.id).group_by(CrewVouch.vouchee_id)
    ).all())
    mine = set(db.scalars(select(CrewVouch.vouchee_id).where(CrewVouch.crew_id == crew.id, CrewVouch.voucher_id == viewer.id)))
    names = community.summaries(db, [m.user_id for m in members], settings, storage)
    events = db.execute(upcoming_events_query().where(Event.crew_id == crew.id).limit(5)).scalars().all()
    return CrewDetail(
        **base.model_dump(),
        members=[
            CrewMemberOut(user=names[m.user_id], role=m.role, member_since=m.joined_at, vouches=int(vouches.get(m.user_id, 0)),
                          vouched_by_me=m.user_id in mine, is_me=m.user_id == viewer.id)
            for m in members if m.user_id in names
        ],
        upcoming_events=serialize_events(db, viewer.id, list(events), settings, storage),
    )


@router.post("/{crew_id}/join", response_model=CrewDetail)
def join_crew(crew_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    limiter.hit("crew:join", str(viewer.id))
    crew = _get_crew(db, crew_id)
    if insert_ignore(db, CrewMember, {"crew_id": crew.id, "user_id": viewer.id, "role": "member", "joined_at": utcnow()}):
        bump(db, Crew, Crew.id == crew.id, members_count=1)
        owner = db.scalar(select(CrewMember.user_id).where(CrewMember.crew_id == crew.id, CrewMember.role == "owner"))
        if owner:
            notifications.notify(db, owner, "crew_join", f"{viewer.user.display_name} joined {crew.name}",
                                 data={"route": f"/crew/{crew.id}", "crew_id": str(crew.id)}, actor_id=viewer.id,
                                 dedupe_key=f"crew_join:{crew.id}:{viewer.id}")
    db.commit()
    return crew_detail(crew.id, db, viewer, settings, storage)


@router.delete("/{crew_id}/membership", status_code=status.HTTP_204_NO_CONTENT)
def leave_crew(crew_id: uuid.UUID, db: DB, viewer: CurrentViewer):
    crew = _get_crew(db, crew_id)
    me = db.get(CrewMember, (crew.id, viewer.id))
    if me is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    db.delete(me)
    db.execute(delete(CrewVouch).where(CrewVouch.crew_id == crew.id,
                                       (CrewVouch.voucher_id == viewer.id) | (CrewVouch.vouchee_id == viewer.id)))
    db.flush()
    if me.role == "owner":
        heir = db.scalars(select(CrewMember).where(CrewMember.crew_id == crew.id).order_by(CrewMember.joined_at, CrewMember.user_id).limit(1)).first()
        if heir is None:
            db.delete(crew)
            db.commit()
            return Response(status_code=status.HTTP_204_NO_CONTENT)
        heir.role = "owner"
    bump(db, Crew, Crew.id == crew.id, members_count=-1)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _vouch_state(db, crew_id, user_id, viewer_id) -> VouchResult:
    count = int(db.scalar(select(func.count()).select_from(CrewVouch).where(CrewVouch.crew_id == crew_id, CrewVouch.vouchee_id == user_id)) or 0)
    mine = db.get(CrewVouch, (crew_id, viewer_id, user_id)) is not None
    return VouchResult(vouches=count, vouched_by_me=mine)


@router.post("/{crew_id}/members/{user_id}/vouch", response_model=VouchResult)
def vouch(crew_id: uuid.UUID, user_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    limiter.hit("vouch", str(viewer.id))
    crew = _get_crew(db, crew_id)
    if user_id == viewer.id:
        raise invalid("You can't vouch for yourself.", "self_vouch")
    if not community.is_member(db, crew.id, viewer.id):
        raise forbidden("Join the crew to vouch for its members.")
    if not community.is_member(db, crew.id, user_id):
        raise not_found("They aren't in this crew.")
    if insert_ignore(db, CrewVouch, {"crew_id": crew.id, "voucher_id": viewer.id, "vouchee_id": user_id, "created_at": utcnow()}):
        notifications.notify(db, user_id, "vouch", f"{viewer.user.display_name} vouched for you",
                             f"in {crew.name}", data={"route": f"/crew/{crew.id}", "crew_id": str(crew.id)},
                             actor_id=viewer.id, dedupe_key=f"vouch:{crew.id}:{viewer.id}")
    db.commit()
    return _vouch_state(db, crew.id, user_id, viewer.id)


@router.delete("/{crew_id}/members/{user_id}/vouch", response_model=VouchResult)
def unvouch(crew_id: uuid.UUID, user_id: uuid.UUID, db: DB, viewer: CurrentViewer):
    crew = _get_crew(db, crew_id)
    db.execute(delete(CrewVouch).where(CrewVouch.crew_id == crew.id, CrewVouch.voucher_id == viewer.id, CrewVouch.vouchee_id == user_id))
    db.commit()
    return _vouch_state(db, crew.id, user_id, viewer.id)
