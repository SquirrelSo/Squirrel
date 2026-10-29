"""Membership (waitlist + referrals), community settings, daily stats and the XP boards.

  GET  /v1/me/membership            queue position, referral code and progress, founding badge
  POST /v1/me/referral {code}       joined with a friend's invite code
  GET  /v1/community/config         hostels to pick from, founding and referral rules
  GET  /v1/stats/daily?days=7       campus totals per local day, and mine today
  GET  /v1/leaderboards/xp?window=daily|weekly     top 10 by XP earned, with names
  GET  /v1/leaderboards/hostels?window=daily|weekly  hostel vs hostel: XP of each hostel's members

XP is the Run Module's (it scores runs and workouts, with its caps and anti-cheat); the boards
read it with the caller's token and add the names and hostels Social knows.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.deps import DB, AppSettings, CurrentViewer, Limiter, RunModuleDep, Storage
from app.models import Badge, Member, User
from app.schemas_community import (
    ClaimReferralRequest,
    CommunityConfig,
    DailyStats,
    FoundingOut,
    HostelBoard,
    HostelEntry,
    MembershipOut,
    XpBoard,
    XpBoardEntry,
)
from app.services import community, membership

router = APIRouter(prefix="/v1", tags=["community"])

TOP = 10
# Enough for every member of a campus: the hostel board sums them all.
HOSTEL_BOARD_LIMIT = 1000


def _membership_out(db, viewer, settings, storage) -> MembershipOut:
    member = db.get(Member, viewer.id)
    founding = None
    badge_id = membership.founding_badge_for(member.verified_rank, settings) if member.verified_rank else None
    if badge_id:
        founding = FoundingOut(badge_id=badge_id, title=db.scalar(select(Badge.title).where(Badge.id == badge_id)) or badge_id,
                               rank=member.verified_rank)
    referred_by = None
    if member.referred_by_id:
        referred_by = community.summaries(db, [member.referred_by_id], settings, storage).get(member.referred_by_id)
    return MembershipOut(
        position=member.position,
        effective_position=membership.effective_position(db, member, settings),
        members_total=int(db.scalar(select(func.count()).select_from(Member)) or 0),
        referral_code=member.referral_code,
        invite_url=membership.invite_url(member, settings),
        referrals=member.referrals_count,
        referrals_to_skip=settings.referrals_to_skip,
        skipped=membership.skipped(member, settings),
        admitted=True,
        email_verified=member.email_verified,
        founding=founding,
        referred_by=referred_by,
    )


@router.get("/me/membership", response_model=MembershipOut)
def my_membership(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage):
    return _membership_out(db, viewer, settings, storage)


@router.post("/me/referral", response_model=MembershipOut)
def claim_referral(body: ClaimReferralRequest, db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, limiter: Limiter):
    limiter.hit("referral:claim", str(viewer.id))
    member = db.get(Member, viewer.id)
    membership.claim_referral(db, member, body.code, settings, actor=viewer.user)
    return _membership_out(db, viewer, settings, storage)


@router.get("/community/config", response_model=CommunityConfig)
def community_config(viewer: CurrentViewer, settings: AppSettings):
    return CommunityConfig(hostels=list(settings.hostels), founding_first=settings.founding_first,
                           founding_total=settings.founding_total, referrals_to_skip=settings.referrals_to_skip,
                           timezone=settings.community_timezone)


@router.get("/stats/daily", response_model=DailyStats)
def daily_stats(db: DB, viewer: CurrentViewer, settings: AppSettings, days: int = Query(7, ge=1, le=14)):
    return community.daily_stats(db, viewer.id, settings, days)


def _board(run_module, viewer, window: str, limit: int) -> tuple[dict | None, date]:
    body = run_module.get_xp_board(viewer.token, window, limit)
    day = date.today()
    if body and isinstance(body.get("day"), str):
        try:
            day = date.fromisoformat(body["day"])
        except ValueError:
            pass
    return body, day


def _users_by_subject(db, subjects: list[str]) -> dict[str, User]:
    if not subjects:
        return {}
    return {u.auth_subject: u for u in db.scalars(select(User).where(User.auth_subject.in_(subjects)))}


@router.get("/leaderboards/xp", response_model=XpBoard)
def xp_board(db: DB, viewer: CurrentViewer, settings: AppSettings, storage: Storage, run_module: RunModuleDep,
             window: Literal["daily", "weekly"] = "daily"):
    body, day = _board(run_module, viewer, window, TOP)
    if body is None:
        return XpBoard(window=window, day=community.local_today(settings), entries=[], me=None, available=False)
    rows = [e for e in body["entries"] if isinstance(e, dict)]
    me_row = body.get("me") if isinstance(body.get("me"), dict) else None
    users = _users_by_subject(db, [str(e.get("user_id")) for e in rows + ([me_row] if me_row else [])])
    names = community.summaries(db, [u.id for u in users.values()], settings, storage)

    def entry(e: dict) -> XpBoardEntry | None:
        user = users.get(str(e.get("user_id")))
        if user is None or user.id not in names:  # an account that never opened Social
            return None
        return XpBoardEntry(rank=int(e["rank"]), xp=int(e["xp"]), user=names[user.id], hostel=user.hostel,
                            is_me=user.id == viewer.id)

    entries = [x for x in (entry(e) for e in rows) if x is not None]
    return XpBoard(window=window, day=day, entries=entries, me=entry(me_row) if me_row else None, available=True)


@router.get("/leaderboards/hostels", response_model=HostelBoard)
def hostel_board(db: DB, viewer: CurrentViewer, settings: AppSettings, run_module: RunModuleDep,
                 window: Literal["daily", "weekly"] = "daily"):
    today = community.local_today(settings)
    if not settings.hostels:
        return HostelBoard(window=window, day=today, enabled=False, entries=[], available=True)
    members = dict(db.execute(
        select(User.hostel, func.count()).where(User.hostel.in_(settings.hostels)).group_by(User.hostel)
    ).all())
    body, day = _board(run_module, viewer, window, HOSTEL_BOARD_LIMIT)
    xp: dict[str, int] = {h: 0 for h in settings.hostels}
    active: dict[str, int] = {h: 0 for h in settings.hostels}
    if body is not None:
        rows = [e for e in body["entries"] if isinstance(e, dict)]
        users = _users_by_subject(db, [str(e.get("user_id")) for e in rows])
        for e in rows:
            user = users.get(str(e.get("user_id")))
            if user is not None and user.hostel in xp:
                xp[user.hostel] += int(e.get("xp") or 0)
                active[user.hostel] += 1
    ordered = sorted(settings.hostels, key=lambda h: (-xp[h], -active[h], h))
    entries = [
        HostelEntry(rank=i + 1, hostel=h, xp=xp[h], members=int(members.get(h, 0)), active=active[h],
                    is_mine=viewer.user.hostel == h)
        for i, h in enumerate(ordered)
    ]
    return HostelBoard(window=window, day=day if body else today, enabled=True, entries=entries, available=body is not None)
