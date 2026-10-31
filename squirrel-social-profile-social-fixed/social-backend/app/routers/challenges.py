"""Head-to-head challenges: most verified km, or most workouts, over 1–30 days.

  GET  /v1/challenges                      mine: pending, running and recently finished
  POST /v1/challenges {opponent_id, metric, days}
  POST /v1/challenges/{id}/accept          the clock starts now
  POST /v1/challenges/{id}/decline
  POST /v1/challenges/{id}/cancel          the challenger withdraws a pending one

Scores come from `activities` (runs the Run Module accepted, workouts the Exercise backend
measured), never from the app. A challenge is settled the first time it is read after it ends;
both sides are told who won.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from fastapi import APIRouter, status
from sqlalchemy import func, or_, select

from app.db import utcnow
from app.deps import DB, AppSettings, CurrentViewer, Limiter, Storage
from app.errors import conflict, forbidden, invalid, not_found
from app.models import Activity, Challenge, User
from app.schemas_community import ChallengeList, ChallengeOut, ChallengeSide, CreateChallengeRequest
from app.services import community
from app.services import notify as notifications
from app.services.dates import is_blocked
from app.services.social import can_see_content

router = APIRouter(prefix="/v1/challenges", tags=["challenges"])

MAX_OPEN = 10
RECENT = timedelta(days=14)


def score(db, user_id: uuid.UUID, metric: str, start, end) -> float:
    counted = (Activity.user_id == user_id, Activity.verified.is_(True), Activity.source != "manual",
               Activity.started_at >= start, Activity.started_at < end)
    if metric == "km":
        total = db.scalar(select(func.coalesce(func.sum(Activity.distance_m), 0)).where(*counted, Activity.type == "run"))
        return round(float(total or 0) / 1000, 2)
    return float(db.scalar(select(func.count(Activity.id)).where(*counted, Activity.type == "workout")) or 0)


def _metric_text(metric: str, value: float) -> str:
    return f"{value:.1f} km" if metric == "km" else f"{int(value)} workout{'s' if value != 1 else ''}"


def settle_due(db, user_id: uuid.UUID) -> None:
    """Finish this user's challenges that have ended, and tell both sides."""
    now = utcnow()
    due = db.scalars(select(Challenge).where(
        Challenge.status == "accepted", Challenge.ends_at <= now,
        or_(Challenge.challenger_id == user_id, Challenge.opponent_id == user_id),
    )).all()
    for c in due:
        c.challenger_score = score(db, c.challenger_id, c.metric, c.starts_at, c.ends_at)
        c.opponent_score = score(db, c.opponent_id, c.metric, c.starts_at, c.ends_at)
        c.winner_id = (c.challenger_id if c.challenger_score > c.opponent_score
                       else c.opponent_id if c.opponent_score > c.challenger_score else None)
        c.status, c.finished_at = "finished", now
        names = dict(db.execute(select(User.id, User.display_name).where(User.id.in_([c.challenger_id, c.opponent_id]))).all())
        for me, other, mine, theirs in ((c.challenger_id, c.opponent_id, c.challenger_score, c.opponent_score),
                                        (c.opponent_id, c.challenger_id, c.opponent_score, c.challenger_score)):
            outcome = "You won" if c.winner_id == me else "It's a draw" if c.winner_id is None else "You lost"
            notifications.notify(db, me, "challenge_finished", f"{outcome} against {names.get(other, 'your opponent')}",
                                 f"{_metric_text(c.metric, mine)} vs {_metric_text(c.metric, theirs)}",
                                 data={"route": "/challenges", "challenge_id": str(c.id)}, dedupe_key=f"challenge_finished:{c.id}")
    if due:
        db.commit()


def serialize(db, viewer_id, challenges: list[Challenge], settings, storage) -> list[ChallengeOut]:
    names = community.summaries(db, {u for c in challenges for u in (c.challenger_id, c.opponent_id)}, settings, storage)
    now = utcnow()
    out = []
    for c in challenges:
        other = c.opponent_id if c.challenger_id == viewer_id else c.challenger_id
        if viewer_id not in names or other not in names:
            continue
        if c.status == "finished":
            mine = c.challenger_score if c.challenger_id == viewer_id else c.opponent_score
            theirs = c.opponent_score if c.challenger_id == viewer_id else c.challenger_score
        elif c.status == "accepted":
            end = min(now, c.ends_at)
            mine, theirs = score(db, viewer_id, c.metric, c.starts_at, end), score(db, other, c.metric, c.starts_at, end)
        else:
            mine = theirs = 0.0
        out.append(ChallengeOut(
            id=c.id, metric=c.metric, days=c.days, status=c.status, created_at=c.created_at, starts_at=c.starts_at,
            ends_at=c.ends_at, me=ChallengeSide(user=names[viewer_id], score=mine or 0.0),
            opponent=ChallengeSide(user=names[other], score=theirs or 0.0), i_challenged=c.challenger_id == viewer_id,
            winner_id=c.winner_id,
        ))
    return out


def _mine(db, viewer_id):
    return or_(Challenge.challenger_id == viewer_id, Challenge.opponent_id == viewer_id)


@router.get("", response_model=ChallengeList)
def list_challenges(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    settle_due(db, viewer.id)
    since = utcnow() - RECENT
    rows = db.scalars(select(Challenge).where(
        _mine(db, viewer.id),
        or_(Challenge.status.in_(["pending", "accepted"]), Challenge.finished_at >= since),
    ).order_by(Challenge.created_at.desc()).limit(50)).all()
    return ChallengeList(items=serialize(db, viewer.id, list(rows), settings, storage))


def _get(db, challenge_id: uuid.UUID, viewer_id) -> Challenge:
    c = db.get(Challenge, challenge_id)
    if c is None or viewer_id not in (c.challenger_id, c.opponent_id):
        raise not_found("Challenge not found.")
    return c


@router.post("", response_model=ChallengeOut, status_code=status.HTTP_201_CREATED)
def create_challenge(body: CreateChallengeRequest, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    limiter.hit("challenge:create", str(viewer.id))
    if body.opponent_id == viewer.id:
        raise invalid("Challenge someone else.", "self_challenge")
    opponent = db.get(User, body.opponent_id)
    if opponent is None or not can_see_content(db, viewer.id, opponent) or is_blocked(db, viewer.id, opponent.id):
        raise not_found("User not found.")
    open_count = db.scalar(select(func.count()).select_from(Challenge).where(
        Challenge.challenger_id == viewer.id, Challenge.status.in_(["pending", "accepted"])))
    if (open_count or 0) >= MAX_OPEN:
        raise conflict(f"You have {MAX_OPEN} challenges going already.", "too_many_challenges")
    c = Challenge(challenger_id=viewer.id, opponent_id=opponent.id, metric=body.metric, days=body.days, status="pending",
                  created_at=utcnow())
    db.add(c)
    db.flush()
    what = "most km run" if body.metric == "km" else "most workouts"
    notifications.notify(db, opponent.id, "challenge", f"{viewer.user.display_name} challenged you",
                         f"{what} in {body.days} day{'s' if body.days != 1 else ''}. Accept?",
                         data={"route": "/challenges", "challenge_id": str(c.id)}, actor_id=viewer.id,
                         dedupe_key=f"challenge:{c.id}")
    db.commit()
    return serialize(db, viewer.id, [c], settings, storage)[0]


@router.post("/{challenge_id}/accept", response_model=ChallengeOut)
def accept(challenge_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    c = _get(db, challenge_id, viewer.id)
    if c.opponent_id != viewer.id:
        raise forbidden("Only the person challenged can accept.")
    if c.status != "pending":
        raise conflict("This challenge isn't waiting for an answer.", "not_pending")
    now = utcnow()
    c.status, c.starts_at, c.ends_at = "accepted", now, now + timedelta(days=c.days)
    notifications.notify(db, c.challenger_id, "challenge_accepted", f"{viewer.user.display_name} accepted your challenge",
                         f"Game on: {c.days} day{'s' if c.days != 1 else ''} from now.",
                         data={"route": "/challenges", "challenge_id": str(c.id)}, actor_id=viewer.id,
                         dedupe_key=f"challenge_accepted:{c.id}")
    db.commit()
    return serialize(db, viewer.id, [c], settings, storage)[0]


@router.post("/{challenge_id}/decline", response_model=ChallengeOut)
def decline(challenge_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    c = _get(db, challenge_id, viewer.id)
    if c.opponent_id != viewer.id:
        raise forbidden("Only the person challenged can decline.")
    if c.status != "pending":
        raise conflict("This challenge isn't waiting for an answer.", "not_pending")
    c.status, c.finished_at = "declined", utcnow()
    db.commit()
    return serialize(db, viewer.id, [c], settings, storage)[0]


@router.post("/{challenge_id}/cancel", response_model=ChallengeOut)
def cancel(challenge_id: uuid.UUID, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    c = _get(db, challenge_id, viewer.id)
    if c.challenger_id != viewer.id:
        raise forbidden("Only the challenger can withdraw it.")
    if c.status != "pending":
        raise conflict("Only a challenge still waiting for an answer can be withdrawn.", "not_pending")
    c.status, c.finished_at = "cancelled", utcnow()
    db.commit()
    return serialize(db, viewer.id, [c], settings, storage)[0]
