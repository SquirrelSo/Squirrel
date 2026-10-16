"""Waitlist, referrals and founding badges.

Every account gets a `members` row the first time it calls the service: a place in the queue (in
the order people joined) and a referral code. Everyone is admitted straight away; the queue is
shown, not enforced. Members whose friends' accounts joined with their code — `referrals_to_skip`
of them, each with a verified email — "skip the line": they move ahead of everyone who has not.

Founding badges follow the order members proved their email address at sign-up (the Exercise
backend's `ev` token claim): the first `founding_first` get Founding Squirrel, the rest of the first
`founding_total` Founding 500. Accounts made before verification existed never count, so test
accounts cannot take the founding places.
"""

from __future__ import annotations

import secrets
from datetime import timedelta

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.errors import ApiError, conflict, invalid, not_found
from app.models import Badge, Member, User
from app.services import ambassador
from app.services import notify as notifications
from app.services.social import award_badge, bump

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I
CODE_LENGTH = 8
# A code can be entered in the first two weeks after joining: enough to finish sign-up later,
# not a way to re-assign friends long after.
CLAIM_WINDOW = timedelta(days=14)


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def ensure_member(db: Session, user: User, verified: bool, settings: Settings) -> Member:
    """The caller's members row, created on first sight; a verified caller gets their founding rank."""
    member = db.get(Member, user.id)
    if member is None:
        member = _create(db, user)
    if verified and member.verified_rank is None:
        _assign_rank(db, member, settings)
    return member


def _create(db: Session, user: User) -> Member:
    for _ in range(8):
        position = (db.scalar(select(func.max(Member.position))) or 0) + 1
        member = Member(user_id=user.id, position=position, referral_code=new_code(), referrals_count=0,
                        email_verified=False, joined_at=utcnow())
        db.add(member)
        try:
            db.commit()
            return member
        except IntegrityError:  # a concurrent sign-up took the position (or, rarely, the code)
            db.rollback()
            existing = db.get(Member, user.id)
            if existing is not None:
                return existing
    raise ApiError(500, "provisioning_failed", "Couldn't set up your membership. Try again.")


def _assign_rank(db: Session, member: Member, settings: Settings) -> None:
    for _ in range(8):
        rank = (db.scalar(select(func.max(Member.verified_rank))) or 0) + 1
        try:
            done = db.execute(
                update(Member)
                .where(Member.user_id == member.user_id, Member.verified_rank.is_(None))
                .values(email_verified=True, verified_rank=rank)
                .returning(Member.user_id)
            ).first()
            if done is None:  # another request of the same user got there first
                db.rollback()
                db.refresh(member)
                return
            # Joined with a friend's code before verifying: it counts for the friend now (once).
            _count_referral(db, member.user_id, settings)
            ambassador.check_referral(db, member.user_id)
            badge = founding_badge_for(rank, settings)
            if badge:
                award_badge(db, member.user_id, badge)
                title = db.scalar(select(Badge.title).where(Badge.id == badge))
                notifications.notify(db, member.user_id, "badge", f"You're a {title}!",
                                     f"Member #{rank} of Squirrel Social. The badge is on your profile.",
                                     data={"route": "/profile", "badge": badge}, dedupe_key=f"badge:{badge}")
            db.commit()
            db.refresh(member)
            return
        except IntegrityError:
            db.rollback()
    raise ApiError(500, "provisioning_failed", "Couldn't record your membership. Try again.")


def founding_badge_for(rank: int, settings: Settings) -> str | None:
    if rank <= settings.founding_first:
        return "founding_squirrel"
    if rank <= settings.founding_total:
        return "founding_500"
    return None


def skipped(member: Member, settings: Settings) -> bool:
    return member.referrals_count >= settings.referrals_to_skip


def effective_position(db: Session, member: Member, settings: Settings) -> int:
    """Your place in line, with everyone who skipped it ahead of everyone who has not."""
    n = settings.referrals_to_skip
    if skipped(member, settings):
        ahead = select(Member.user_id).where(Member.referrals_count >= n, Member.position < member.position)
    else:
        ahead = select(Member.user_id).where(or_(Member.referrals_count >= n,
                                                 and_(Member.referrals_count < n, Member.position < member.position)))
    return int(db.scalar(select(func.count()).select_from(ahead.subquery())) or 0) + 1


def claim_referral(db: Session, member: Member, code: str, settings: Settings, *, actor: User) -> Member:
    """Record that `member` joined with a friend's invite code. It counts for the friend once, and
    only when this account verified its email."""
    code = code.strip().upper()
    if member.referred_by_id is not None:
        raise conflict("You've already used an invite code.", "referral_used")
    referrer = db.scalar(select(Member).where(Member.referral_code == code))
    if referrer is None:
        raise not_found("That invite code doesn't exist.")
    if referrer.user_id == member.user_id:
        raise invalid("That's your own invite code.", "own_code")
    if utcnow() - member.joined_at > CLAIM_WINDOW:
        raise invalid("Invite codes can only be used in your first two weeks.", "claim_window")
    claimed = db.execute(
        update(Member).where(Member.user_id == member.user_id, Member.referred_by_id.is_(None))
        .values(referred_by_id=referrer.user_id).returning(Member.user_id)
    ).first()
    if claimed is None:
        db.rollback()
        raise conflict("You've already used an invite code.", "referral_used")
    db.refresh(member)
    _count_referral(db, member.user_id, settings)  # now if verified, else when they verify
    ambassador.check_referral(db, member.user_id)
    db.commit()
    db.refresh(member)
    return member


def _count_referral(db: Session, member_id, settings: Settings) -> None:
    """Counts a verified member's referral for the referrer, exactly once (members.referral_counted
    decides it: concurrent claim + verification can't both count it), and tells the referrer."""
    referrer_id = db.execute(
        update(Member).where(Member.user_id == member_id, Member.referred_by_id.is_not(None),
                             Member.email_verified.is_(True), Member.referral_counted.is_(False))
        .values(referral_counted=True).returning(Member.referred_by_id)
    ).scalar()
    if referrer_id is None:
        return
    bump(db, Member, Member.user_id == referrer_id, referrals_count=1)
    count = db.scalar(select(Member.referrals_count).where(Member.user_id == referrer_id))
    friend = db.get(User, member_id)
    name = friend.display_name if friend else "A friend"
    notifications.notify(db, referrer_id, "referral", f"{name} joined with your invite",
                         _referral_progress(count, settings), data={"route": "/invite"},
                         actor_id=member_id, dedupe_key=f"referral:{member_id}")


def _referral_progress(count: int, settings: Settings) -> str:
    left = settings.referrals_to_skip - count
    if left > 0:
        return f"{left} more and you skip the line."
    if left == 0:
        return "That's enough: you've skipped the line!"
    return "Thanks for bringing more squirrels in."


def invite_url(member: Member, settings: Settings) -> str | None:
    if not settings.app_url:
        return None
    return f"{settings.app_url}/sign-in?mode=create&invite={member.referral_code}"
