"""Ambassador applications and the ambassador programme (services/ambassador.py).

  GET  /v1/ambassador/application                 apply: the form, or why it's closed, and my status
  POST /v1/ambassador/application
  GET  /v1/ambassador/me                          my profile, status, referral code + invite link, counts
  GET  /v1/ambassador/referrals?cursor=&limit=    people who joined with my code (names/avatars only)
  GET  /v1/ambassador/tasks                       open tasks and my submission for each
  POST /v1/ambassador/tasks/{id}/submit {evidence}   active ambassadors, once per task
  GET  /v1/ambassador/leaderboard?limit=          active ambassadors by activated referrals, then task XP

  Admin (users.role = 'admin'):
  GET  /v1/admin/ambassador/applications
  POST /v1/admin/ambassador/applications/{id}/decision     approving makes the ambassador profile
  POST /v1/admin/ambassadors/{user_id}/suspend {reason} · /reinstate
  POST /v1/admin/ambassador/tasks · PATCH /v1/admin/ambassador/tasks/{id}
  GET  /v1/admin/ambassador/submissions?status= · POST ./{id}/decision {status}
  GET  /v1/admin/ambassador/referrals/analytics
  GET  /v1/admin/ambassador/rewards?user_id= · POST /v1/admin/ambassador/rewards/{id}/reverse {reason?}

The referral claim stays POST /v1/me/referral (routers/community.py): an ambassador's code is their
ordinary members.referral_code.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.auth import Viewer
from app.db import utcnow
from app.deps import DB, AppSettings, CurrentViewer, Limiter, Storage
from app.errors import ApiError, conflict, forbidden, invalid, not_found
from app.models import (
    AmbassadorApplication,
    AmbassadorProfile,
    AmbassadorReward,
    AmbassadorTask,
    AmbassadorTaskSubmission,
    Member,
    User,
    UserStats,
)
from app.pagination import before, clamp_limit, decode_uuid_cursor, encode_cursor
from app.rules import AMBASSADOR_FORM, AMBASSADOR_FORM_VERSION
from app.schemas import UserSummary
from app.schemas_community import (
    AdminAmbassadorApplication,
    AdminAmbassadorDecision,
    AdminAmbassadorList,
    AdminSubmission,
    AdminSubmissionList,
    AmbassadorAnalytics,
    AmbassadorAnalyticsRow,
    AmbassadorCounts,
    AmbassadorLeaderboard,
    AmbassadorLeaderboardEntry,
    AmbassadorMe,
    AmbassadorProfileOut,
    AmbassadorReferral,
    AmbassadorReferralPage,
    AmbassadorTaskList,
    AmbassadorTaskOut,
    AmbassadorTaskWithMine,
    CreateAmbassadorTask,
    MySubmission,
    ReferralPerson,
    RewardList,
    RewardOut,
    ReverseRewardRequest,
    SubmissionDecision,
    SubmitTaskRequest,
    SuspendAmbassadorRequest,
    UpdateAmbassadorTask,
    AmbassadorApplication as SchemaAmbassadorApplication,
    AmbassadorField,
    AmbassadorState,
    CreateAmbassadorApplication,
)
from app.services import ambassador as ambassadors
from app.services import community, membership, notify, social

router = APIRouter(prefix="/v1", tags=["ambassador"])

OPEN_STATUSES = ["pending", "under_review", "approved", "suspended"]


def _check_admin(user: User):
    if user.role != "admin":
        raise forbidden("You can't do that.")


def _serialize_app(app: AmbassadorApplication | None) -> SchemaAmbassadorApplication | None:
    if not app:
        return None
    return SchemaAmbassadorApplication(
        id=app.id,
        status=app.status,
        submitted_at=app.submitted_at,
        decided_at=app.decided_at,
        message=app.message,
    )


@router.get("/ambassador/application", response_model=AmbassadorState)
def get_ambassador_application(db: DB, viewer: CurrentViewer, settings: AppSettings):
    app = db.scalar(select(AmbassadorApplication).where(AmbassadorApplication.user_id == viewer.id).order_by(AmbassadorApplication.submitted_at.desc()).limit(1))
    
    # 1. Verification check (VERIFIED members only)
    member = db.get(Member, viewer.id)
    if not member or not member.email_verified:
        return AmbassadorState(
            open=False, 
            closed_reason="Verify your email to apply.", 
            application=_serialize_app(app), 
            fields=[]
        )
    
    # 2. Reapply cooldown
    if app and app.status == "rejected" and app.decided_at:
        wait_until = app.decided_at + timedelta(days=settings.ambassador_reapply_days)
        if utcnow() < wait_until:
            tz = ZoneInfo(settings.community_timezone)
            date_str = wait_until.astimezone(tz).strftime("%b %d, %Y").replace(" 0", " ")
            return AmbassadorState(
                open=False,
                closed_reason=f"You can apply again on {date_str}.",
                application=_serialize_app(app),
                fields=[]
            )
            
    # 3. Settings open flag
    if not settings.ambassador_open:
        return AmbassadorState(
            open=False,
            closed_reason="Applications are currently closed. Check back soon.",
            application=_serialize_app(app),
            fields=[]
        )

    fields = []
    for f in AMBASSADOR_FORM:
        prefill = None
        if f["key"] == "name":
            prefill = viewer.user.display_name
        elif f["key"] == "hostel":
            prefill = viewer.user.hostel
        fields.append(
            AmbassadorField(
                key=f["key"],
                label=f["label"],
                type=f["type"],
                required=f["required"],
                max_length=f.get("max_length"),
                options=f.get("options"),
                prefill=prefill
            )
        )

    return AmbassadorState(
        open=True,
        closed_reason=None,
        application=_serialize_app(app),
        fields=fields
    )


@router.post("/ambassador/application", response_model=SchemaAmbassadorApplication)
def create_ambassador_application(body: CreateAmbassadorApplication, db: DB, viewer: CurrentViewer, settings: AppSettings, limiter: Limiter):
    # Check if a pending or under_review application already exists for this idempotency key
    # (Or just check existing applications)
    existing = db.scalar(select(AmbassadorApplication).where(AmbassadorApplication.user_id == viewer.id, AmbassadorApplication.idempotency_key == body.idempotency_key))
    if existing:
        return _serialize_app(existing)

    if not settings.ambassador_open:
        raise forbidden("Applications are currently closed. Check back soon.")

    member = db.get(Member, viewer.id)
    if not member or not member.email_verified:
        raise forbidden("Verify your email to apply.")

    last_app = db.scalar(select(AmbassadorApplication).where(AmbassadorApplication.user_id == viewer.id).order_by(AmbassadorApplication.submitted_at.desc()).limit(1))
    if last_app and last_app.status == "rejected" and last_app.decided_at:
        if utcnow() < last_app.decided_at + timedelta(days=settings.ambassador_reapply_days):
            raise forbidden("You cannot reapply yet.")

    # Check for any open applications
    open_app = db.scalar(
        select(AmbassadorApplication)
        .where(AmbassadorApplication.user_id == viewer.id, AmbassadorApplication.status.in_(OPEN_STATUSES))
    )
    if open_app:
        return _serialize_app(open_app)

    # Validation
    answers = body.answers
    form_keys = {f["key"] for f in AMBASSADOR_FORM}
    for k in answers:
        if k not in form_keys:
            raise invalid(f"Unknown field: {k[:40]}")

    for f in AMBASSADOR_FORM:
        val = answers.get(f["key"])
        if not val or not str(val).strip():
            if f["required"]:
                raise invalid(f"Missing required field: {f['key']}")
            continue
            
        val_str = str(val).strip()
        if f.get("max_length") and len(val_str) > f["max_length"]:
            raise invalid(f"Field {f['key']} must be at most {f['max_length']} characters.")
            
        if f["type"] == "select" and f.get("options") and val_str not in f["options"]:
            raise invalid(f"Field {f['key']} must be one of the options.")
            
        answers[f["key"]] = val_str

    limiter.hit("ambassador", str(viewer.id))
    
    app = AmbassadorApplication(
        user_id=viewer.id,
        status="pending",
        form_version=AMBASSADOR_FORM_VERSION,
        answers=answers,
        idempotency_key=body.idempotency_key
    )
    db.add(app)
    try:
        db.flush()
        db.commit()
    except IntegrityError:
        db.rollback()
        open_app = db.scalar(
            select(AmbassadorApplication)
            .where(AmbassadorApplication.user_id == viewer.id, AmbassadorApplication.status.in_(OPEN_STATUSES))
        )
        if open_app:
            return _serialize_app(open_app)
        raise conflict("Could not complete application submission due to a database conflict.")
    
    return _serialize_app(app)


@router.get("/admin/ambassador/applications", response_model=AdminAmbassadorList)
def list_ambassador_applications(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, status: Literal["pending", "under_review", "approved", "rejected", "suspended"] | None = None, limit: int = 50):
    _check_admin(viewer.user)
    limit = clamp_limit(limit)
    
    query = (
        select(AmbassadorApplication, User, UserStats.xp)
        .join(User, User.id == AmbassadorApplication.user_id)
        .join(UserStats, UserStats.user_id == User.id)
    )
    if status:
        query = query.where(AmbassadorApplication.status == status)
    
    query = query.order_by(AmbassadorApplication.submitted_at.desc()).limit(limit)
    rows = db.execute(query).all()
    
    urls = social.media_urls(db, storage, [u.avatar_media_id for _, u, _ in rows])
    items = []
    for app, u, xp in rows:
        items.append(
            AdminAmbassadorApplication(
                id=app.id,
                status=app.status,
                submitted_at=app.submitted_at,
                decided_at=app.decided_at,
                message=app.message,
                user=social.user_summary(u, xp, settings, urls.get(u.avatar_media_id)),
                answers=app.answers,
                form_version=app.form_version
            )
        )
    return AdminAmbassadorList(items=items)


@router.post("/admin/ambassador/applications/{id}/decision", response_model=SchemaAmbassadorApplication)
def decide_ambassador_application(id: uuid.UUID, body: AdminAmbassadorDecision, db: DB, viewer: CurrentViewer, settings: AppSettings):
    _check_admin(viewer.user)
    
    app = db.get(AmbassadorApplication, id)
    if not app:
        raise not_found("Application not found")
        
    if app.status in ("approved", "rejected", "suspended"):
        raise conflict("Already decided")
        
    if app.status == "pending" and body.status not in ("under_review", "approved", "rejected"):
        raise conflict("Invalid transition")
        
    if app.status == "under_review" and body.status not in ("approved", "rejected"):
        raise conflict("Invalid transition")
        
    app.status = body.status
    if body.status in ("approved", "rejected"):
        app.decided_at = utcnow()
    app.message = body.message
    
    if body.status == "approved":
        db.flush()
        ambassadors.ensure_profile(db, app)
        notify.notify(
            db, 
            app.user_id, 
            "ambassador", 
            "Application Approved", 
            body.message or "Welcome to the crew behind the crew.", 
            data={"route": "/ambassador"}, 
            dedupe_key=f"ambassador:{app.id}:{body.status}"
        )
    elif body.status == "rejected":
        notify.notify(
            db, 
            app.user_id, 
            "ambassador", 
            "Application Not This Time", 
            body.message or "Thanks for putting your hand up. Keep moving — there'll be another round.", 
            data={"route": "/ambassador"}, 
            dedupe_key=f"ambassador:{app.id}:{body.status}"
        )
        
    db.commit()
    
    return _serialize_app(app)


# --------------------------------------------------------------------------- the programme: ambassadors


def _my_profile(db, viewer) -> AmbassadorProfile:
    profile = ambassadors.get_profile(db, viewer.id)
    if profile is None:
        raise ApiError(404, "not_ambassador", "You're not an ambassador yet.")
    return profile


def _task_out(t: AmbassadorTask) -> AmbassadorTaskOut:
    return AmbassadorTaskOut(id=t.id, title=t.title, description=t.description, xp_reward=t.xp_reward,
                             starts_at=t.starts_at, ends_at=t.ends_at, active=t.active)


def _open_tasks(now):
    return select(AmbassadorTask).where(
        AmbassadorTask.active.is_(True), AmbassadorTask.starts_at <= now,
        or_(AmbassadorTask.ends_at.is_(None), AmbassadorTask.ends_at > now))


@router.get("/ambassador/me", response_model=AmbassadorMe)
def ambassador_me(db: DB, viewer: CurrentViewer, settings: AppSettings):
    profile = _my_profile(db, viewer)
    # Rewards held back (daily limit) or not yet confirmed by the Run Module are retried here.
    ambassadors.sweep(db, viewer.id)
    ambassadors.mark_pending(db)
    db.commit()
    member = db.get(Member, viewer.id)
    c = ambassadors.counts(db, [viewer.id])[viewer.id]
    return AmbassadorMe(status=profile.status, approved_at=profile.approved_at, suspended_at=profile.suspended_at,
                        suspension_reason=profile.suspension_reason, referral_code=member.referral_code,
                        invite_url=membership.invite_url(member, settings), counts=AmbassadorCounts(**c))


@router.get("/ambassador/referrals", response_model=AmbassadorReferralPage)
def ambassador_referrals(db: DB, viewer: CurrentViewer, storage: Storage, cursor: str | None = None, limit: int = 20):
    profile = _my_profile(db, viewer)
    n = clamp_limit(limit)
    stmt = select(Member.user_id, Member.joined_at).where(Member.referred_by_id == viewer.id)
    if cursor:
        ts, key = decode_uuid_cursor(cursor)
        stmt = stmt.where(before(Member.joined_at, Member.user_id, ts, key))
    rows = db.execute(stmt.order_by(Member.joined_at.desc(), Member.user_id.desc()).limit(n + 1)).all()
    page = rows[:n]
    ids = [uid for uid, _ in page]
    ambassadors.refresh_activation(db, ids)
    state = ambassadors.referral_rows(db, viewer.id, profile.status == "active", ids)
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}
    urls = social.media_urls(db, storage, [u.avatar_media_id for u in users.values()])
    items = []
    for uid, joined in page:
        u = users.get(uid)
        if u is None:
            continue
        # Public name and avatar only: no username, email, hostel or anything private.
        items.append(AmbassadorReferral(
            user=ReferralPerson(id=u.id, display_name=u.display_name, avatar_look=u.avatar_look,
                                avatar_url=urls.get(u.avatar_media_id)),
            signup_at=joined, **state[uid]))
    db.commit()
    return AmbassadorReferralPage(items=items, next_cursor=encode_cursor(page[-1][1], page[-1][0]) if len(rows) > n else None)


@router.get("/ambassador/tasks", response_model=AmbassadorTaskList)
def ambassador_tasks(db: DB, viewer: CurrentViewer):
    _my_profile(db, viewer)
    tasks = list(db.scalars(_open_tasks(utcnow()).order_by(AmbassadorTask.starts_at.desc(), AmbassadorTask.id)))
    mine = {s.task_id: s for s in db.scalars(select(AmbassadorTaskSubmission).where(
        AmbassadorTaskSubmission.user_id == viewer.id, AmbassadorTaskSubmission.task_id.in_([t.id for t in tasks])))} if tasks else {}
    return AmbassadorTaskList(items=[
        AmbassadorTaskWithMine(**_task_out(t).model_dump(), submission=MySubmission(
            id=m.id, status=m.status, submitted_at=m.submitted_at, reviewed_at=m.reviewed_at) if (m := mine.get(t.id)) else None)
        for t in tasks
    ])


@router.post("/ambassador/tasks/{task_id}/submit", response_model=MySubmission, status_code=201)
def submit_task(task_id: uuid.UUID, body: SubmitTaskRequest, db: DB, viewer: CurrentViewer, limiter: Limiter):
    profile = _my_profile(db, viewer)
    if profile.status != "active":
        raise forbidden("Your ambassador role is paused.")
    task = db.scalar(_open_tasks(utcnow()).where(AmbassadorTask.id == task_id))
    if task is None:
        raise not_found("Task not found.")
    limiter.hit("ambassador:submit", str(viewer.id))
    sub = AmbassadorTaskSubmission(task_id=task.id, user_id=viewer.id, status="submitted", evidence=body.evidence,
                                   submitted_at=utcnow())
    db.add(sub)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise conflict("You've already submitted this task.", "already_submitted") from None
    return MySubmission(id=sub.id, status=sub.status, submitted_at=sub.submitted_at, reviewed_at=None)


@router.get("/ambassador/leaderboard", response_model=AmbassadorLeaderboard)
def ambassador_leaderboard(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limit: int = 10):
    n = clamp_limit(limit)
    active = list(db.scalars(select(AmbassadorProfile.user_id).where(AmbassadorProfile.status == "active")))
    if not active:
        return AmbassadorLeaderboard(entries=[])
    activated = dict(db.execute(
        select(Member.referred_by_id, func.count()).where(Member.referred_by_id.in_(active), Member.activated_at.is_not(None))
        .group_by(Member.referred_by_id)).all())
    task_xp = dict(db.execute(
        select(AmbassadorReward.user_id, func.sum(AmbassadorReward.xp)).where(
            AmbassadorReward.user_id.in_(active), AmbassadorReward.kind == "task",
            AmbassadorReward.awarded_at.is_not(None), AmbassadorReward.reversed_at.is_(None))
        .group_by(AmbassadorReward.user_id)).all())
    ranked = sorted(active, key=lambda u: (-int(activated.get(u, 0)), -int(task_xp.get(u, 0) or 0), str(u)))[:n]
    names = community.summaries(db, ranked, settings, storage)
    return AmbassadorLeaderboard(entries=[
        AmbassadorLeaderboardEntry(rank=i + 1, user=names[u], activated_referrals=int(activated.get(u, 0)),
                                   task_xp=int(task_xp.get(u, 0) or 0), is_me=u == viewer.id)
        for i, u in enumerate(ranked) if u in names
    ])


# --------------------------------------------------------------------------- the programme: admin


def _admin(viewer, limiter) -> None:
    _check_admin(viewer.user)
    limiter.hit("ambassador:admin", str(viewer.id))


def _profile_out(p: AmbassadorProfile) -> AmbassadorProfileOut:
    return AmbassadorProfileOut(user_id=p.user_id, status=p.status, approved_at=p.approved_at,
                                suspended_at=p.suspended_at, suspension_reason=p.suspension_reason)


@router.post("/admin/ambassadors/{user_id}/suspend", response_model=AmbassadorProfileOut)
def suspend_ambassador(user_id: uuid.UUID, body: SuspendAmbassadorRequest, db: DB, viewer: CurrentViewer, limiter: Limiter):
    _admin(viewer, limiter)
    profile = ambassadors.get_profile(db, user_id)
    if profile is None:
        raise not_found("Ambassador not found.")
    ambassadors.set_status(db, profile, "suspended", body.reason)
    db.commit()
    return _profile_out(profile)


@router.post("/admin/ambassadors/{user_id}/reinstate", response_model=AmbassadorProfileOut)
def reinstate_ambassador(user_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter):
    _admin(viewer, limiter)
    profile = ambassadors.get_profile(db, user_id)
    if profile is None:
        raise not_found("Ambassador not found.")
    ambassadors.set_status(db, profile, "active")
    ambassadors.mark_pending(db)  # rewards that waited out the suspension
    db.commit()
    return _profile_out(profile)


@router.post("/admin/ambassador/tasks", response_model=AmbassadorTaskOut, status_code=201)
def create_task(body: CreateAmbassadorTask, db: DB, viewer: CurrentViewer, limiter: Limiter):
    _admin(viewer, limiter)
    now = utcnow()
    task = AmbassadorTask(title=body.title, description=body.description, xp_reward=body.xp_reward,
                          starts_at=body.starts_at or now, ends_at=body.ends_at, active=body.active,
                          created_by=viewer.id, created_at=now)
    if task.ends_at is not None and task.ends_at <= task.starts_at:
        raise invalid("ends_at must be after starts_at.")
    db.add(task)
    db.flush()
    if task.active:
        active = list(db.scalars(select(AmbassadorProfile.user_id).where(AmbassadorProfile.status == "active")))
        notify.notify(db, active, "ambassador.task", f"New ambassador task: {task.title}"[:120],
                      f"Worth {task.xp_reward} XP.", data={"route": "/ambassador/tasks", "task_id": str(task.id)},
                      actor_id=viewer.id, dedupe_key=f"ambassador.task:{task.id}")
    db.commit()
    return _task_out(task)


@router.patch("/admin/ambassador/tasks/{task_id}", response_model=AmbassadorTaskOut)
def update_task(task_id: uuid.UUID, body: UpdateAmbassadorTask, db: DB, viewer: CurrentViewer, limiter: Limiter):
    _admin(viewer, limiter)
    task = db.get(AmbassadorTask, task_id)
    if task is None:
        raise not_found("Task not found.")
    changes = body.model_dump(exclude_unset=True)
    for field in ("title", "xp_reward", "starts_at", "active", "description"):
        if field in changes and changes[field] is None:
            raise invalid(f"{field} can't be null.")
    for field, value in changes.items():
        setattr(task, field, value)
    if task.ends_at is not None and task.ends_at <= task.starts_at:
        raise invalid("ends_at must be after starts_at.")
    db.commit()
    return _task_out(task)


@router.get("/admin/ambassador/submissions", response_model=AdminSubmissionList)
def list_submissions(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter,
                     status: Literal["submitted", "approved", "rejected"] | None = None, limit: int = 50):
    _admin(viewer, limiter)
    stmt = select(AmbassadorTaskSubmission, AmbassadorTask).join(AmbassadorTask, AmbassadorTask.id == AmbassadorTaskSubmission.task_id)
    if status:
        stmt = stmt.where(AmbassadorTaskSubmission.status == status)
    rows = db.execute(stmt.order_by(AmbassadorTaskSubmission.submitted_at.desc(), AmbassadorTaskSubmission.id)
                      .limit(clamp_limit(limit))).all()
    names = community.summaries(db, {s.user_id for s, _ in rows}, settings, storage)
    return AdminSubmissionList(items=[
        AdminSubmission(id=s.id, task=_task_out(t), user=names[s.user_id], status=s.status, evidence=s.evidence,
                        submitted_at=s.submitted_at, reviewed_at=s.reviewed_at)
        for s, t in rows if s.user_id in names
    ])


@router.post("/admin/ambassador/submissions/{submission_id}/decision", response_model=MySubmission)
def decide_submission(submission_id: uuid.UUID, body: SubmissionDecision, db: DB, viewer: CurrentViewer, limiter: Limiter):
    _admin(viewer, limiter)
    sub = db.get(AmbassadorTaskSubmission, submission_id)
    if sub is None:
        raise not_found("Submission not found.")
    if sub.status != "submitted":
        raise conflict("Already decided.", "already_decided")
    done = db.execute(update(AmbassadorTaskSubmission).where(
        AmbassadorTaskSubmission.id == sub.id, AmbassadorTaskSubmission.status == "submitted",
    ).values(status=body.status, reviewed_at=utcnow(), reviewer_id=viewer.id).returning(AmbassadorTaskSubmission.id)).first()
    if done is None:  # a concurrent decision won
        db.rollback()
        raise conflict("Already decided.", "already_decided")
    task = db.get(AmbassadorTask, sub.task_id)
    if body.status == "approved":
        ambassadors.grant_task(db, sub.user_id, task.id, task.xp_reward)
    else:
        notify.notify(db, sub.user_id, "ambassador.task", f"Not approved: {task.title}"[:120],
                      "Your submission wasn't accepted this time.", data={"route": "/ambassador/tasks", "task_id": str(task.id)},
                      dedupe_key=f"ambassador.task:{task.id}:rejected")
    db.commit()
    db.refresh(sub)
    return MySubmission(id=sub.id, status=sub.status, submitted_at=sub.submitted_at, reviewed_at=sub.reviewed_at)


@router.get("/admin/ambassador/referrals/analytics", response_model=AmbassadorAnalytics)
def referral_analytics(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    _admin(viewer, limiter)
    ambassadors.refresh_activation(db)
    db.commit()
    counts = ambassadors.counts(db)
    profiles = {p.user_id: p for p in db.scalars(select(AmbassadorProfile))}
    names = community.summaries(db, list(counts), settings, storage)
    rows = [AmbassadorAnalyticsRow(user=names[uid], status=profiles[uid].status, **c)
            for uid, c in sorted(counts.items(), key=lambda kv: (-kv[1]["activated"], -kv[1]["referred"], str(kv[0])))
            if uid in names]
    totals = {k: sum(c[k] for c in counts.values()) for k in AmbassadorCounts.model_fields}
    return AmbassadorAnalytics(ambassadors=rows, totals=AmbassadorCounts(**totals))


def _reward_out(r: AmbassadorReward) -> RewardOut:
    return RewardOut(id=r.id, user_id=r.user_id, kind=r.kind, ref_id=r.ref_id, xp=r.xp, created_at=r.created_at,
                     awarded_at=r.awarded_at, reversed_at=r.reversed_at)


@router.get("/admin/ambassador/rewards", response_model=RewardList)
def list_rewards(db: DB, viewer: CurrentViewer, limiter: Limiter, user_id: uuid.UUID | None = None, limit: int = 50):
    _admin(viewer, limiter)
    stmt = select(AmbassadorReward)
    if user_id:
        stmt = stmt.where(AmbassadorReward.user_id == user_id)
    rows = db.scalars(stmt.order_by(AmbassadorReward.created_at.desc(), AmbassadorReward.id).limit(clamp_limit(limit)))
    return RewardList(items=[_reward_out(r) for r in rows])


@router.post("/admin/ambassador/rewards/{reward_id}/reverse", response_model=RewardOut)
def reverse_reward(reward_id: uuid.UUID, db: DB, viewer: CurrentViewer, limiter: Limiter, body: ReverseRewardRequest | None = None):
    _admin(viewer, limiter)
    reward = db.get(AmbassadorReward, reward_id)
    if reward is None:
        raise not_found("Reward not found.")
    ambassadors.reverse(db, reward, (body or ReverseRewardRequest()).reason)
    db.commit()
    db.refresh(reward)
    return _reward_out(reward)
