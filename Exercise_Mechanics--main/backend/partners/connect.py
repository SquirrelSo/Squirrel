"""Partner Hunt Connect: ask someone on your board to train together; once both have said yes, each
learns the other's Social profile.

Until then everything stays anonymous: a request carries the same card as the board (first name and
last initial, age band, level, what you share), never a photo, a full name or a profile link. After
an accept, each side gets the other's Social profile id (people/resolve), and nothing more from here.

    send     you must pass every board check, and they must be on your board right now (otherwise
             404 not_on_board — the same answer a block gives)
    decline  silent: the sender keeps seeing "pending" until the request expires, as if unanswered
    blocks   Social's, either direction: a blocked pair is refused (404) and dropped from every list;
             when Social can't be asked, 503 blocks_unreachable (fail closed)
    limits   one live request per pair; one request to the same person per REQUEST_COOLDOWN_DAYS,
             however it ended; MAX_NEW_REQUESTS_PER_DAY; MAX_PENDING_OUTGOING

    remove   either person may remove an accepted connection (a "buddy"), silently: nothing tells
             the other, the connection simply disappears from both lists, and the pair's cooldown
             (REQUEST_COOLDOWN_DAYS) runs from the removal before either can ask again

Notifications go through Social (partner.request, partner.accepted). The request one names nobody
to Social: sending the sender as the actor would attach their profile before they are connected.
A removal sends nothing (contract: `partner.disconnected` is not sent).

XP: an accepted connection earns each person buddy_connected (20 XP) from the Run Module, once per
pair per person (xp_awards.py; the idempotency key is the pair, so reconnecting earns nothing more).
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

from backend import card_ids, social_blocks, social_notify, social_people, xp_awards
from backend.partners import requests_store, service
from backend.partners.matching import Person, age_band, display_name, is_age_eligible, score
from backend.partners.policy import (
    MAX_NEW_REQUESTS_PER_DAY,
    MAX_PENDING_OUTGOING,
    REQUEST_COOLDOWN_DAYS,
    REQUEST_TTL_DAYS,
)
from backend.partners.service import PartnerHuntError
from backend.partners.xp_gate import XPGate

REQUEST_ID_RE = re.compile(r"^[0-9a-f]{32}$")

PENDING, ACCEPTED, DECLINED, WITHDRAWN, REMOVED = "pending", "accepted", "declined", "withdrawn", "removed"


def utcnow() -> datetime:
    """The clock. Tests replace it."""
    return datetime.now(timezone.utc)


# --- the routes ------------------------------------------------------------------------------------

def list_requests(user_id: str) -> dict:
    me = _eligible_person(user_id)
    blocked = _blocked(user_id, "so your requests are withheld")
    now = utcnow()
    incoming, outgoing, connected = [], [], []
    for row in sorted(requests_store.rows_for(user_id), key=lambda r: r["created_at"], reverse=True):
        mine = row["from_user"] == user_id
        other_id = row["to_user"] if mine else row["from_user"]
        if other_id in blocked:
            continue
        if row["status"] == ACCEPTED:
            connected.append(row)
        elif mine and row["status"] in (PENDING, DECLINED) and now < row["created_at"] + _cooldown():
            outgoing.append(row)          # declined reads as pending (then expired), never as declined
        elif not mine and row["status"] == PENDING and now < row["expires_at"]:
            incoming.append(row)

    people = _people({_other(r, user_id) for r in incoming + outgoing + connected})
    profiles = _profile_ids([_other(r, user_id) for r in connected if _other(r, user_id) in people])
    return {
        "incoming": [_request_item(r, me, people[_other(r, user_id)], now) for r in incoming if _other(r, user_id) in people],
        "outgoing": [_request_item(r, me, people[_other(r, user_id)], now) for r in outgoing if _other(r, user_id) in people],
        "connections": [_connection_item(r, me, people[o], profiles[o])
                        for r in connected if (o := _other(r, user_id)) in people],
    }


def send_request(user_id: str, card_id: str, gate: XPGate) -> dict:
    # Every board check, in the board's own order and with its own errors; then the card must be on
    # it (its id is only ever resolved among the people on this viewer's board right now).
    board = service.board(user_id, gate)
    to_user_id = card_ids.resolve(card_ids.PARTNER_HUNT, user_id, card_id, [m.user_id for m in board])
    if to_user_id is None:
        raise _not_on_board()
    me = _eligible_person(user_id)
    them = service._load_person(to_user_id, None)
    now = utcnow()
    row = {"request_id": uuid.uuid4().hex, "from_user": user_id, "to_user": to_user_id, "status": PENDING,
           "created_at": now, "expires_at": now + timedelta(days=REQUEST_TTL_DAYS), "decided_at": None}

    with requests_store.transaction(_sender_key(user_id), _pair_key(user_id, to_user_id)) as tx:
        rows = tx.rows_for(user_id)
        pair = [r for r in rows if to_user_id in (r["from_user"], r["to_user"])]
        if any(r["status"] == ACCEPTED for r in pair):
            raise PartnerHuntError(409, "already_connected", "You're already connected.")
        removed = max((r["removed_at"] for r in pair if r["status"] == REMOVED and r.get("removed_at")),
                      default=None)
        if removed is not None and now < removed + _cooldown():
            # Either of them removed the connection: the same wait as after any other request.
            raise PartnerHuntError(429, "too_soon", "You can ask them again later.",
                                   retry_after=_iso(removed + _cooldown()))
        theirs = next((r for r in pair if r["from_user"] == to_user_id and r["status"] == PENDING
                       and now < r["expires_at"]), None)
        if theirs is not None:
            raise PartnerHuntError(409, "they_asked_you", "They've already asked you: accept their request.",
                                   request_id=theirs["request_id"])
        last = max((r for r in pair if r["from_user"] == user_id), key=lambda r: r["created_at"], default=None)
        if last is not None and now < last["created_at"] + _cooldown():
            if last["status"] in (PENDING, DECLINED) and now < last["expires_at"]:
                raise PartnerHuntError(409, "already_requested", "You've already asked them.",
                                       request_id=last["request_id"])
            raise PartnerHuntError(429, "too_soon", "You can ask them again later.",
                                   retry_after=_iso(last["created_at"] + _cooldown()))
        sent = [r for r in rows if r["from_user"] == user_id]
        if sum(now - r["created_at"] < timedelta(days=1) for r in sent) >= MAX_NEW_REQUESTS_PER_DAY:
            raise PartnerHuntError(429, "daily_limit",
                                   f"You can send {MAX_NEW_REQUESTS_PER_DAY} requests a day. Try again tomorrow.")
        if sum(r["status"] in (PENDING, DECLINED) and now < r["expires_at"] for r in sent) >= MAX_PENDING_OUTGOING:
            raise PartnerHuntError(429, "too_many_pending",
                                   f"You have {MAX_PENDING_OUTGOING} requests waiting. Wait for some answers first.")
        tx.insert(row)

    social_notify.notify(
        user_subject=to_user_id, kind="partner.request",
        title=f"{display_name(me.first_name, me.last_name)} wants to work out with you",
        body="Open Partner Hunt to accept or decline.",
        data={"route": "/partner-hunt", "request_id": row["request_id"]},
        dedupe_key=f"partner.request:{row['request_id']}",
    )
    return _request_item(row, me, them, now)


def accept(user_id: str, request_id: str) -> dict:
    me = _eligible_person(user_id)
    row = _own_request(request_id, user_id, as_role="to_user")
    now = utcnow()
    if row["status"] != ACCEPTED and (row["status"] != PENDING or now >= row["expires_at"]):
        raise _request_not_found()
    sender = row["from_user"]
    if sender in _blocked(user_id, "so nothing was accepted"):
        raise _request_not_found()
    them = service._load_person(sender, None)
    if them is None or not is_age_eligible(them):
        raise _request_not_found()
    profile_id = _profile_ids([sender])[sender]
    if row["status"] == ACCEPTED:
        return _connection_item(row, me, them, profile_id)

    with requests_store.transaction(_pair_key(user_id, sender)) as tx:
        current = tx.get(request_id)
        accepted_now = current["status"] == PENDING and now < current["expires_at"]
        if accepted_now:
            tx.set_status(request_id, ACCEPTED, now)
        elif current["status"] != ACCEPTED:
            raise _request_not_found()
        row = tx.get(request_id)

    social_notify.notify(
        user_subject=sender, kind="partner.accepted", actor_subject=user_id,
        title="{actor} accepted your Partner Hunt request",
        body="You can see each other's profiles now.",
        data={"route": f"/partner-hunt/connect/{request_id}", "request_id": request_id},
        dedupe_key=f"partner.accepted:{request_id}",
    )
    if accepted_now:
        for subject in (user_id, sender):
            xp_awards.award(subject=subject, reason=xp_awards.BUDDY_CONNECTED,
                            idempotency_key=xp_awards.buddy_key(user_id, sender, subject), source_id=request_id)
    return _connection_item(row, me, them, profile_id)


def decline(user_id: str, request_id: str) -> None:
    """Silent: nothing tells the sender. Declining twice, or a request the sender took back, is fine."""
    _eligible_person(user_id)
    _decide(user_id, request_id, as_role="to_user", status=DECLINED)


def withdraw(user_id: str, request_id: str) -> None:
    """The sender takes a request back. A request that was declined is withdrawn the same way, so the
    sender never learns it was declined."""
    _decide(user_id, request_id, as_role="from_user", status=WITHDRAWN)


def remove_connection(user_id: str, request_id: str) -> None:
    """Either person ends an accepted connection. Silent: the other is not told. Removing one that
    is already removed is fine; anything that is not your connection is 404 (the same as unknown)."""
    row = requests_store.get(request_id) if REQUEST_ID_RE.fullmatch(request_id or "") else None
    if row is None or user_id not in (row["from_user"], row["to_user"]) or row["status"] not in (ACCEPTED, REMOVED):
        raise _connection_not_found()
    with requests_store.transaction(_pair_key(row["from_user"], row["to_user"])) as tx:
        current = tx.get(request_id)
        if current["status"] == ACCEPTED:
            tx.mark_removed(request_id, user_id, utcnow())
        elif current["status"] != REMOVED:
            raise _connection_not_found()


def buddy_subjects(user_id: str) -> set[str]:
    """The login subjects of everyone `user_id` is connected with right now (accepted, not removed).
    Blocks are the caller's to apply."""
    return {_other(r, user_id) for r in requests_store.rows_for(user_id) if r["status"] == ACCEPTED}


# --- helpers ---------------------------------------------------------------------------------------

def _decide(user_id: str, request_id: str, *, as_role: str, status: str) -> None:
    row = _own_request(request_id, user_id, as_role=as_role)
    with requests_store.transaction(_pair_key(row["from_user"], row["to_user"])) as tx:
        current = tx.get(request_id)["status"]
        if current == ACCEPTED:
            raise PartnerHuntError(409, "already_connected", "This request was accepted; you're connected.")
        if current == PENDING or (current == DECLINED and status == WITHDRAWN):
            tx.set_status(request_id, status, utcnow())


def _own_request(request_id: str, user_id: str, *, as_role: str) -> dict:
    row = requests_store.get(request_id) if REQUEST_ID_RE.fullmatch(request_id or "") else None
    if row is None or row[as_role] != user_id:
        raise _request_not_found()
    return row


def _eligible_person(user_id: str) -> Person:
    person = service._require_person(user_id, None)
    if not is_age_eligible(person):
        raise service._age_error()
    return person


def _people(user_ids: set[str]) -> dict[str, Person]:
    """The people behind the rows, leaving out anyone deleted or no longer age-eligible."""
    out = {}
    for uid in user_ids:
        person = service._load_person(uid, None)
        if person is not None and is_age_eligible(person):
            out[uid] = person
    return out


def _card(viewer: Person, other: Person) -> dict:
    """The board's card for `other`, as `viewer` sees it, without the score: the same card_id as on
    the board, never the account id."""
    if viewer.preferences is not None and other.preferences is not None:
        card = service.public_card(viewer.user_id, score(viewer, other).to_dict())
        card.pop("score")
        card.pop("reasons")
        return card
    # Someone has since cleared their preferences: who they are, but nothing shared to show.
    return {"card_id": card_ids.card_id(card_ids.PARTNER_HUNT, viewer.user_id, other.user_id),
            "display_name": display_name(other.first_name, other.last_name),
            "age_band": age_band(other.age), "fitness_level": other.fitness_level,
            "shared_activities": [], "shared_times": [], "meet": [], "city": None}


def _request_item(row: dict, viewer: Person, other: Person, now: datetime) -> dict:
    live = row["status"] in (PENDING, DECLINED) and now < row["expires_at"]
    return {
        "request_id": row["request_id"],
        "status": PENDING if live else "expired",
        "created_at": _iso(row["created_at"]),
        "expires_at": _iso(row["expires_at"]),
        "person": _card(viewer, other),
    }


def _connection_item(row: dict, viewer: Person, other: Person, profile_id: str) -> dict:
    return {
        "request_id": row["request_id"],
        "accepted_at": _iso(row["decided_at"]),
        "person": {**_card(viewer, other), "social_profile_id": profile_id},
    }


def _profile_ids(subjects: list[str]) -> dict[str, str]:
    if not subjects:
        return {}
    try:
        return {sub: person["user_id"] for sub, person in social_people.resolve(subjects).items()}
    except social_people.SocialUnreachable as exc:
        raise PartnerHuntError(503, "social_unreachable",
                               "Profiles couldn't be loaded right now. Try again in a moment.") from exc


def _blocked(user_id: str, consequence: str) -> frozenset[str]:
    try:
        return social_blocks.blocked_either_way(user_id)
    except social_blocks.BlocksUnreachable as exc:
        raise service._blocks_unreachable_error(consequence) from exc


def _other(row: dict, user_id: str) -> str:
    return row["to_user"] if row["from_user"] == user_id else row["from_user"]


def _cooldown() -> timedelta:
    return timedelta(days=REQUEST_COOLDOWN_DAYS)


def _sender_key(user_id: str) -> str:
    return f"partner-requests:from:{user_id}"


def _pair_key(a: str, b: str) -> str:
    return "partner-requests:pair:" + ":".join(sorted((a, b)))


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _not_on_board() -> PartnerHuntError:
    return PartnerHuntError(404, "not_on_board", "That member isn't on your board.")


def _request_not_found() -> PartnerHuntError:
    return PartnerHuntError(404, "request_not_found", "That request isn't available any more.")


def _connection_not_found() -> PartnerHuntError:
    return PartnerHuntError(404, "connection_not_found", "That connection isn't available.")
