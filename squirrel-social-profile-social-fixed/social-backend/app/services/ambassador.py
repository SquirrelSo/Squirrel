"""The ambassador programme: profiles, referral rewards, tasks and their XP.

An approved application makes an `ambassador_profiles` row (`ensure_profile`, idempotent). The
ambassador's referral code is their ordinary members.referral_code: one code system.

A referral earns the ambassador REFERRAL_XP once, when all of these hold:
  * the friend claimed the ambassador's code (POST /v1/me/referral; members.referred_by_id),
  * the friend's email is verified,
  * the friend is *activated*: an activity reached Social through POST /internal/v1/activities
    (source run_module or exercise) no later than ACTIVATION_WINDOW after they joined,
  * the ambassador's profile is active (not suspended).
At most REFERRAL_REWARDS_PER_DAY referral rewards are granted per ambassador per local day; the
rest stay eligible and are granted on a later check (any of the triggers below, or the ambassador
opening their page).

XP lives in the Run Module (ADR-032). A reward is first a row here (`ambassador_rewards`, unique on
the Run Module idempotency key), written in the transaction that made it due; after that commit it
is sent to POST /internal/v1/xp/award (`settle`). A failed call is logged and the row stays pending
(awarded_at NULL) for the next settle, up to MAX_ATTEMPTS. Reversal (admin) marks the row and sends
POST /internal/v1/xp/reverse the same way. A suspended ambassador's pending rewards wait.

Settling runs after the commit of any session that queued one (`mark_pending`), in a session of
its own: hooks below, attached per request in deps.get_db.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta

from zoneinfo import ZoneInfo

from sqlalchemy import case, event, func, select, update
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.models import (
    Activity,
    AmbassadorApplication,
    AmbassadorProfile,
    AmbassadorReward,
    Member,
    User,
    UserStats,
)
from app.services import push
from app.services import notify as notifications
from app.services.run_module import RunModule, is_run_module_subject
from app.services.social import insert_ignore

log = logging.getLogger(__name__)

REFERRAL_XP = 50
REFERRAL_REWARDS_PER_DAY = 20
ACTIVATION_WINDOW = timedelta(days=30)
ACTIVATING_SOURCES = ("run_module", "exercise")
MAX_ATTEMPTS = 10
SETTLE_BATCH = 200
REASONS = {"referral": "ambassador_referral", "task": "ambassador_task"}


# --------------------------------------------------------------------------- profiles


def get_profile(db: Session, user_id: uuid.UUID) -> AmbassadorProfile | None:
    return db.get(AmbassadorProfile, user_id)


def is_active(db: Session, user_id: uuid.UUID) -> bool:
    profile = get_profile(db, user_id)
    return profile is not None and profile.status == "active"


def ensure_profile(db: Session, application: AmbassadorApplication) -> None:
    """The ambassador profile of an approved application; a second approval changes nothing."""
    now = utcnow()
    insert_ignore(db, AmbassadorProfile, {"user_id": application.user_id, "application_id": application.id,
                                          "status": "active", "approved_at": now, "created_at": now,
                                          "suspended_at": None, "suspension_reason": None})
    sweep(db, application.user_id)


def set_status(db: Session, profile: AmbassadorProfile, status: str, reason: str | None = None) -> None:
    """Suspend or reinstate; the open application follows (suspended ↔ approved)."""
    if profile.status == status:
        return
    now = utcnow()
    profile.status = status
    if status == "suspended":
        profile.suspended_at, profile.suspension_reason = now, reason
    else:
        profile.suspended_at, profile.suspension_reason = None, None
    db.execute(update(AmbassadorApplication).where(
        AmbassadorApplication.user_id == profile.user_id,
        AmbassadorApplication.status == ("approved" if status == "suspended" else "suspended"),
    ).values(status="suspended" if status == "suspended" else "approved"))
    if status == "suspended":
        notifications.notify(db, profile.user_id, "ambassador.suspended", "Your ambassador role is paused",
                             (reason or "Reach out to the team if you have questions.")[:240],
                             data={"route": "/ambassador"}, dedupe_key=f"ambassador.suspended:{int(now.timestamp())}")
    else:
        sweep(db, profile.user_id)


# --------------------------------------------------------------------------- activation & referrals


def refresh_activation(db: Session, user_ids: Iterable[uuid.UUID] | None = None) -> None:
    """Sets members.activated_at for referred members who qualify but aren't marked yet (an
    activity that arrived before they had a members row, or before this column existed)."""
    stmt = select(Member.user_id, Member.joined_at).where(Member.referred_by_id.is_not(None), Member.activated_at.is_(None))
    if user_ids is not None:
        ids = list(user_ids)
        if not ids:
            return
        stmt = stmt.where(Member.user_id.in_(ids))
    joined = dict(db.execute(stmt).all())
    if not joined:
        return
    first = dict(db.execute(
        select(Activity.user_id, func.min(Activity.created_at))
        .where(Activity.user_id.in_(list(joined)), Activity.source.in_(ACTIVATING_SOURCES))
        .group_by(Activity.user_id)
    ).all())
    for user_id, at in first.items():
        if at is not None and at <= joined[user_id] + ACTIVATION_WINDOW:
            db.execute(update(Member).where(Member.user_id == user_id, Member.activated_at.is_(None)).values(activated_at=at))


def after_activity(db: Session, activity: Activity) -> None:
    """A new activity was ingested: it may activate a referred member and make a reward due."""
    if activity.source not in ACTIVATING_SOURCES:
        return
    member = db.get(Member, activity.user_id)
    if member is None or member.referred_by_id is None:
        return
    db.execute(update(Member).where(
        Member.user_id == member.user_id, Member.activated_at.is_(None),
        Member.joined_at >= activity.created_at - ACTIVATION_WINDOW,
    ).values(activated_at=activity.created_at))
    check_referral(db, member.user_id)


def check_referral(db: Session, referred_id: uuid.UUID) -> None:
    """Grants the referral reward for one referred member if it is due (see the module doc)."""
    referrer = db.scalar(select(Member.referred_by_id).where(Member.user_id == referred_id))
    if referrer is not None:
        _grant(db, referrer, [referred_id])


def sweep(db: Session, ambassador_id: uuid.UUID) -> None:
    """Grants every due referral reward of one ambassador (up to the daily limit)."""
    refresh_activation(db, db.scalars(select(Member.user_id).where(
        Member.referred_by_id == ambassador_id, Member.activated_at.is_(None))).all())
    _grant(db, ambassador_id, None)


def _today_start(tz: str, now: datetime) -> datetime:
    local = now.astimezone(ZoneInfo(tz))
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


def _grant(db: Session, ambassador_id: uuid.UUID, only: list[uuid.UUID] | None) -> int:
    if not is_active(db, ambassador_id):
        return 0
    rewarded = select(AmbassadorReward.ref_id).where(AmbassadorReward.user_id == ambassador_id, AmbassadorReward.kind == "referral")
    stmt = (select(Member.user_id).where(
        Member.referred_by_id == ambassador_id, Member.email_verified.is_(True), Member.activated_at.is_not(None))
        .order_by(Member.activated_at, Member.user_id))
    if only is not None:
        stmt = stmt.where(Member.user_id.in_(only))
    already = set(db.scalars(rewarded))
    due = [u for u in db.scalars(stmt) if str(u) not in already]
    if not due:
        return 0
    now = utcnow()
    attached = db.info.get("ambassador")
    since = _today_start(attached[1].community_timezone if attached else "UTC", now)
    today = int(db.scalar(select(func.count()).select_from(AmbassadorReward).where(
        AmbassadorReward.user_id == ambassador_id, AmbassadorReward.kind == "referral",
        AmbassadorReward.created_at >= since)) or 0)
    granted = 0
    for referred in due[:max(0, REFERRAL_REWARDS_PER_DAY - today)]:
        if insert_ignore(db, AmbassadorReward, {
            "id": uuid.uuid4(), "user_id": ambassador_id, "kind": "referral", "ref_id": str(referred), "xp": REFERRAL_XP,
            "idempotency_key": f"referral:{referred}", "created_at": now, "awarded_at": None, "attempts": 0,
            "reversed_at": None, "reversal_reason": None, "reverse_synced_at": None,
        }):
            granted += 1
    if granted:
        mark_pending(db)
    return granted


def grant_task(db: Session, user_id: uuid.UUID, task_id: uuid.UUID, xp: int) -> None:
    now = utcnow()
    insert_ignore(db, AmbassadorReward, {
        "id": uuid.uuid4(), "user_id": user_id, "kind": "task", "ref_id": str(task_id), "xp": xp,
        "idempotency_key": f"task:{task_id}:{user_id}", "created_at": now, "awarded_at": None, "attempts": 0,
        "reversed_at": None, "reversal_reason": None, "reverse_synced_at": None,
    })
    mark_pending(db)


def reverse(db: Session, reward: AmbassadorReward, reason: str) -> None:
    if reward.reversed_at is not None:
        return
    reward.reversed_at, reward.reversal_reason = utcnow(), reason[:200]
    mark_pending(db)


# --------------------------------------------------------------------------- referral state (lists)


def referral_rows(db: Session, ambassador_id: uuid.UUID, active: bool, member_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    """verified / activated / reward_eligible / rewarded for some of an ambassador's referrals."""
    if not member_ids:
        return {}
    members = {m.user_id: m for m in db.scalars(select(Member).where(Member.user_id.in_(member_ids)))}
    rewards = {r.ref_id: r for r in db.scalars(select(AmbassadorReward).where(
        AmbassadorReward.user_id == ambassador_id, AmbassadorReward.kind == "referral",
        AmbassadorReward.ref_id.in_([str(i) for i in member_ids])))}
    out = {}
    for uid, m in members.items():
        r = rewards.get(str(uid))
        out[uid] = {
            "verified": m.email_verified,
            "activated": m.activated_at is not None,
            "reward_eligible": active and m.email_verified and m.activated_at is not None and (r is None or r.reversed_at is None),
            "rewarded": r is not None and r.awarded_at is not None and r.reversed_at is None,
        }
    return out


def counts(db: Session, ambassador_ids: list[uuid.UUID] | None = None) -> dict[uuid.UUID, dict[str, int]]:
    """Per ambassador: referred, verified, activated, rewarded (paid, not reversed), task_xp."""
    profiles = select(AmbassadorProfile.user_id)
    if ambassador_ids is not None:
        profiles = profiles.where(AmbassadorProfile.user_id.in_(ambassador_ids))
    ids = list(db.scalars(profiles))
    out = {i: {"referred": 0, "verified": 0, "activated": 0, "rewarded": 0, "referral_xp": 0, "task_xp": 0} for i in ids}
    if not ids:
        return out
    for ref, n, verified, activated in db.execute(
        select(Member.referred_by_id, func.count(),
               func.sum(case((Member.email_verified.is_(True), 1), else_=0)),
               func.count(Member.activated_at))
        .where(Member.referred_by_id.in_(ids)).group_by(Member.referred_by_id)
    ):
        out[ref].update(referred=int(n), verified=int(verified or 0), activated=int(activated or 0))
    for uid, kind, n, xp in db.execute(
        select(AmbassadorReward.user_id, AmbassadorReward.kind, func.count(), func.sum(AmbassadorReward.xp))
        .where(AmbassadorReward.user_id.in_(ids), AmbassadorReward.awarded_at.is_not(None), AmbassadorReward.reversed_at.is_(None))
        .group_by(AmbassadorReward.user_id, AmbassadorReward.kind)
    ):
        if kind == "referral":
            out[uid].update(rewarded=int(n), referral_xp=int(xp or 0))
        else:
            out[uid]["task_xp"] = int(xp or 0)
    return out


# --------------------------------------------------------------------------- settling with the Run Module


def attach(db: Session, run_module: RunModule, settings: Settings) -> Session:
    db.info["ambassador"] = (run_module, settings)
    return db


def mark_pending(db: Session) -> None:
    db.info["ambassador_settle"] = True


def settle(db: Session, run_module: RunModule, settings: Settings) -> int:
    """Sends pending awards and reversals to the Run Module. Returns how many went through."""
    if not run_module.configured or not settings.internal_token or not hasattr(run_module, "award_xp"):
        return 0
    token = settings.internal_token
    now = utcnow()
    done = 0
    awards = db.execute(
        select(AmbassadorReward, User.auth_subject)
        .join(User, User.id == AmbassadorReward.user_id)
        .join(AmbassadorProfile, AmbassadorProfile.user_id == AmbassadorReward.user_id)
        .where(AmbassadorReward.awarded_at.is_(None), AmbassadorReward.reversed_at.is_(None),
               AmbassadorReward.attempts < MAX_ATTEMPTS, AmbassadorProfile.status == "active")
        .order_by(AmbassadorReward.created_at).limit(SETTLE_BATCH)
    ).all()
    for reward, subject in awards:
        reward.attempts += 1
        if not is_run_module_subject(subject):
            log.warning("ambassador reward %s: subject is not a Run Module id", reward.id)
            continue
        total = run_module.award_xp(token, subject, reward.xp, REASONS[reward.kind], reward.idempotency_key,
                                    source_id=reward.ref_id)
        if total is None:
            continue
        reward.awarded_at = now
        done += 1
        _cache_total(db, reward.user_id, total, now)
        what = "a friend you invited got moving" if reward.kind == "referral" else "your task was approved"
        notifications.notify(db, reward.user_id, "ambassador.reward", f"+{reward.xp} XP", f"Ambassador reward: {what}.",
                             data={"route": "/ambassador", "xp": reward.xp}, dedupe_key=f"ambassador.reward:{reward.idempotency_key}")
    reversals = db.execute(
        select(AmbassadorReward)
        .where(AmbassadorReward.reversed_at.is_not(None), AmbassadorReward.reverse_synced_at.is_(None),
               AmbassadorReward.attempts > 0)
        .order_by(AmbassadorReward.reversed_at).limit(SETTLE_BATCH)
    ).scalars().all()
    for reward in reversals:
        total = run_module.reverse_xp(token, reward.idempotency_key, reward.reversal_reason or "reversed by admin")
        if total is None:
            continue
        reward.reverse_synced_at = now
        done += 1
        if total >= 0:
            _cache_total(db, reward.user_id, total, now)
    db.commit()
    return done


def _cache_total(db: Session, user_id: uuid.UUID, total: int, now: datetime) -> None:
    """The Run Module's answer is the one thing the XP cache may store (ADR-032 "XP reads")."""
    db.execute(update(UserStats).where(UserStats.user_id == user_id).values(xp=total, xp_synced_at=now))


@event.listens_for(Session, "after_commit")
def _settle_after_commit(session: Session) -> None:
    # after_commit also fires when a SAVEPOINT is released; only the real commit counts.
    if session.in_nested_transaction() or not session.info.pop("ambassador_settle", None):
        return
    attached = session.info.get("ambassador")
    if not attached:
        return
    run_module, settings = attached
    try:
        bind = session.get_bind()
        with Session(bind=bind) as own:
            push.attach(own, session.info.get("push"))
            own.info["ambassador"] = attached
            settle(own, run_module, settings)
    except Exception:  # never fail a committed request over XP; the rows stay pending
        log.exception("settling ambassador rewards failed")


@event.listens_for(Session, "after_rollback")
def _drop_after_rollback(session: Session) -> None:
    session.info.pop("ambassador_settle", None)

