"""Shared workout use cases. Every error carries a machine-readable code (SharedWorkoutError.detail)
so the app can say exactly what happened.

Who may see what:
    a session (GET, socket)   only the people in it; anyone else gets 404, so its existence isn't revealed
    an invite (preview, join) anyone signed in with the code, unless either of you has blocked the
                              other (404, the same as an unknown code); blocks are Social's and the
                              check fails closed (503 blocks_unreachable)
    ready (with a partner)    blocks checked again: a blocked pair's lobby closes for both, quietly;
                              503 blocks_unreachable when Social can't be asked. Never during a race.
    invite (host, lobby)      only one of the host's Partner Hunt connections (403 not_a_buddy, which
                              is also what a block gives); blocks fail closed (503); at most
                              MAX_PENDING_INVITES waiting (429 too_many_invites); idempotent per person
    decline (invitee)         silent: only the session view shows it; 404 if you weren't invited
    cancel (host, lobby)      closes the lobby for everyone (left_reason "cancelled")

People are shown by their Social PersonLite, looked up when they create or join (503
social_unreachable when Social can't answer), and stored with the session, so an outage during a
race doesn't blank anyone's name.

Settling a race: when a race reaches `finished` (time up, or every player finished or left) the
next write or read settles it, exactly once (completed_at in the document, set under the session's
lock): each player who didn't leave before the end and reported a rep earns shared_workout_finished
from the Run Module (xp_awards.py), both are notified (shared_workout.finished) and the socket gets
workout.session.completed. Races nobody looks at any more are settled by finalise_due (a background
sweep). Hand-tapped reps are checked for plausibility (422 implausible_reps) and rate-limited
(429 rate_limited); nothing is written to activity_sessions.
"""

from __future__ import annotations

import logging
import re
import secrets
import threading
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone

from backend import config, social_blocks, social_notify, social_people, xp_awards
from backend.partners import connect as partner_connect
from backend.shared_workouts import hub, model, presence, store
from backend.shared_workouts.policy import (
    EXERCISES,
    INVITE_ALPHABET,
    INVITE_LENGTH,
    MAX_PENDING_INVITES,
    REPS_RATE_PER_S,
)

log = logging.getLogger(__name__)

_SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CODE_RE = re.compile(rf"^[{INVITE_ALPHABET}]{{{INVITE_LENGTH}}}$")


def utcnow() -> datetime:
    """The clock. Tests replace it."""
    return datetime.now(timezone.utc)


class SharedWorkoutError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: object) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message, **self.extra}


# --- the routes ------------------------------------------------------------------------------------

def create(user_id: str, exercise_key: str, duration_s: int) -> dict:
    now = utcnow()
    if exercise_key not in EXERCISES:
        raise SharedWorkoutError(422, "invalid_exercise", "Shared workouts are rep races: pick a rep exercise.")
    _ensure_free(user_id, now, except_session=None)
    person = _resolve(user_id)
    for _ in range(5):
        doc = model.new_session(uuid.uuid4().hex, _new_code(), exercise_key, duration_s, user_id, person, now)
        try:
            store.insert(doc)
            break
        except store.DuplicateInviteCode:
            continue
    else:
        raise RuntimeError("could not draw an unused invite code")
    try:
        finalise_due()
        store.prune(now)
    except Exception:  # noqa: BLE001 — housekeeping must never fail a create
        log.exception("could not settle or prune closed shared workouts")
    presence.touch(doc["session_id"], user_id, now)
    return render(doc, user_id, now)


def get(session_id: str, user_id: str) -> dict:
    now = utcnow()
    doc = _participant_session(session_id, user_id, now)
    return render(doc, user_id, now)


def preview(code: str, user_id: str) -> dict:
    now = utcnow()
    session_id = _session_for_code(code)
    doc = _read(session_id)
    if model.player(doc, user_id) is not None:
        presence.touch(session_id, user_id, now)
        doc = _swept(doc, now)
    else:
        _refuse_if_blocked(user_id, doc, _blocked(user_id))
    return render(doc, user_id, now)


def join(code: str, user_id: str) -> dict:
    now = utcnow()
    session_id = _session_for_code(code)
    doc = _read(session_id)
    if model.player(doc, user_id) is not None:
        presence.touch(session_id, user_id, now)
        return render(_swept(doc, now), user_id, now)
    _check_joinable(doc, now)
    blocked = _blocked(user_id)
    _refuse_if_blocked(user_id, doc, blocked)
    _ensure_free(user_id, now, except_session=session_id)
    person = _resolve(user_id)

    def change(d: dict) -> None:
        if model.player(d, user_id) is not None:
            return
        _check_joinable(d, now)                 # again, under the lock: the seat may have gone
        _refuse_if_blocked(user_id, d, blocked)  # …or someone else may hold the other seat now
        model.join(d, user_id, person, now)

    doc = _update(session_id, change, now)
    presence.touch(session_id, user_id, now)
    publish_session(doc, now)
    return render(doc, user_id, now)


def set_ready(session_id: str, user_id: str, ready: bool) -> dict:
    now = utcnow()
    doc = _participant_session(session_id, user_id, now)
    # Readying up with a partner seated is the last step before the race, so blocks are checked
    # again here (either may have blocked the other since joining). Fails closed: no race starts
    # while Social can't be asked.
    others = [p for p in model.seated(doc) if p["user_id"] != user_id]
    blocked = _blocked(user_id) if ready and others and model.phase(doc, now) == model.LOBBY else None

    def change(d: dict) -> None:
        me = _me(d, user_id)
        current = model.phase(d, now)
        if d["starts_at"] is not None:
            raise SharedWorkoutError(409, "already_started", "The countdown has started; ready can't change now.")
        if current != model.LOBBY:
            raise SharedWorkoutError(409, "not_in_lobby", "This session has ended.", phase=current)
        if blocked and any(p["user_id"] in blocked for p in model.seated(d) if p is not me):
            model.close_lobby(d, now)          # quietly: the same for both, no error, no reason given
            return
        model.set_ready(d, me, ready, now)

    doc = _update(session_id, change, now)
    publish_session(doc, now)
    return render(doc, user_id, now)


def report_reps(session_id: str, user_id: str, reps: int, seq: int) -> dict:
    now = utcnow()
    _throttle_reps(user_id, now)
    _participant_session(session_id, user_id, now)

    def change(d: dict) -> bool:
        me = _me(d, user_id)
        if not model.can_report(d, me, now):
            raise _not_racing(d, now)
        _check_plausible(d, reps, now)
        return model.report(me, reps, seq)

    doc, accepted = _update_with_result(session_id, change, now)
    me = model.player(doc, user_id)
    if accepted:
        _publish_reps(doc, me, now)
    return {"accepted": accepted, "reps": me["reps"], "seq": me["seq"]}


def complete(session_id: str, user_id: str, reps: int, seq: int) -> dict:
    now = utcnow()
    _participant_session(session_id, user_id, now)

    def change(d: dict) -> bool:
        me = _me(d, user_id)
        if me["finished_at"] is not None:
            return False                       # already finished: nothing changes
        if not model.can_report(d, me, now):
            raise _not_racing(d, now)
        _check_plausible(d, reps, now)
        accepted = model.report(me, reps, seq)
        me["finished_at"] = model.iso(min(now, model.parse(d["ends_at"])))
        return accepted

    doc, accepted = _update_with_result(session_id, change, now)
    if accepted:
        _publish_reps(doc, model.player(doc, user_id), now)
    publish_session(doc, now)
    return render(doc, user_id, now)


def leave(session_id: str, user_id: str) -> dict:
    now = utcnow()
    _participant_session(session_id, user_id, now)

    def change(d: dict) -> None:
        me = _me(d, user_id)
        if model.phase(d, now) in (model.EXPIRED, model.FINISHED) or me["left_at"] or me["finished_at"]:
            return                             # nothing left to leave
        model.leave(d, me, now)

    doc = _update(session_id, change, now)
    publish_session(doc, now)
    return render(doc, user_id, now)


def invite(session_id: str, user_id: str, social_profile_id: str) -> dict:
    """The host invites one of their Partner Hunt connections (by Social profile id) to the lobby."""
    now = utcnow()
    doc = _participant_session(session_id, user_id, now)
    _check_host_lobby(doc, user_id, now)
    if len(model.seated(doc)) >= 2:
        raise _session_full()
    blocked = _blocked(user_id)
    buddies = partner_connect.buddy_subjects(user_id) - blocked - {user_id}
    people = _resolve_many(sorted(buddies))
    wanted = social_profile_id.lower()
    target = next((sub for sub, person in people.items() if person["user_id"].lower() == wanted), None)
    if target is None:
        # Not a connection — or blocked either way, which reads the same.
        raise SharedWorkoutError(403, "not_a_buddy", "You can only invite people you're connected with.")
    person = people[target]

    def change(d: dict) -> bool:
        _check_host_lobby(d, user_id, now)
        if model.invite_for(d, target) is not None or model.player(d, target) is not None:
            return False                       # already invited (or declined, or seated): no change
        if len(model.seated(d)) >= 2:
            raise _session_full()
        if len(model.pending_invites(d)) >= MAX_PENDING_INVITES:
            raise SharedWorkoutError(429, "too_many_invites",
                                     f"Up to {MAX_PENDING_INVITES} invitations can wait at once.")
        model.add_invite(d, target, person["user_id"], person, now)
        return True

    doc, added = _update_with_result(session_id, change, now)
    if added:
        code = doc["invite_code"]
        social_notify.notify(
            user_subject=target, kind="shared_workout.invited", actor_subject=user_id,
            title="{actor} invited you to a shared workout",
            body=f"{EXERCISES[doc['exercise_key']]} race, {doc['duration_s'] // 60} min. Join before the lobby closes.",
            data={"code": code, "session_id": doc["session_id"], "route": f"/workout/join/{code}"},
            dedupe_key=f"shared_workout.invited:{doc['session_id']}:{target}",
        )
        invited = model.invite_for(doc, target)
        message = {"type": "workout.session.invited", "data": {
            "session_id": doc["session_id"],
            "invite": {"user": invited["person"], "status": invited["status"], "invited_at": invited["invited_at"]}}}
        hub.publish(doc["session_id"], lambda _listener: [message])
        publish_session(doc, now)
    return render(doc, user_id, now)


def decline_invite(code: str, user_id: str) -> None:
    """An invited person says no. Silent: nobody is told; the host's session view shows it."""
    now = utcnow()
    session_id = _session_for_code(code)
    if model.invite_for(_read(session_id), user_id) is None:
        raise _not_found()

    def change(d: dict) -> bool:
        invited = model.invite_for(d, user_id)
        if invited is None:
            raise _not_found()
        if invited["status"] == "declined":
            return False
        model.decline_invite(invited, now)
        return True

    doc, declined = _update_with_result(session_id, change, now)
    if declined:
        publish_session(doc, now)


def cancel(session_id: str, user_id: str) -> dict:
    """The host closes an unstarted lobby for everyone. Cancelling twice is fine."""
    now = utcnow()
    _participant_session(session_id, user_id, now)

    def change(d: dict) -> bool:
        me = _me(d, user_id)
        if me["role"] != "host":
            raise _not_host()
        if d["starts_at"] is None and all(p["left_reason"] == "cancelled" for p in d["players"]):
            return False                       # already cancelled
        if d["starts_at"] is not None:
            raise SharedWorkoutError(409, "already_started", "The countdown has started; it can't be cancelled now.")
        current = model.phase(d, now)
        if current != model.LOBBY:
            raise SharedWorkoutError(409, "not_in_lobby", "This session has ended.", phase=current)
        model.close_lobby(d, now, reason="cancelled")
        return True

    doc, cancelled = _update_with_result(session_id, change, now)
    if cancelled:
        message = {"type": "workout.session.cancelled", "data": {"session_id": doc["session_id"], "at": model.iso(now)}}
        hub.publish(doc["session_id"], lambda _listener: [message])
        publish_session(doc, now)
    return render(doc, user_id, now)


def finalise_due(limit: int = 100) -> int:
    """Settle races that finished with nobody looking (both apps closed): the background sweep, and
    housekeeping on create. Returns how many were settled."""
    now = utcnow()
    settled = 0
    for doc in store.due_for_completion(now, limit):
        if not model.completion_due(doc, now):
            continue
        try:
            _swept(doc, now)
            settled += 1
        except Exception:  # noqa: BLE001 — one bad session must not stop the rest
            log.exception("could not settle shared workout %s", doc.get("session_id"))
    return settled


# --- the socket ------------------------------------------------------------------------------------

def socket_open(session_id: str, user_id: str) -> tuple[list[dict], bool]:
    """For a socket being opened: the first message, and whether the session is already over (send
    it, then close). Raises SharedWorkoutError(404) for anyone not in the session."""
    now = utcnow()
    doc = _participant_session(session_id, user_id, now)
    return [session_message(doc, user_id, now)], _closed(doc, now)


def ping(session_id: str, user_id: str) -> dict:
    now = utcnow()
    presence.touch(session_id, user_id, now)
    return {"type": "pong", "data": {"server_time": model.iso(now)}}


def tick(session_id: str, previous: tuple | None) -> tuple | None:
    """One sweep of a session that has sockets open: end the race of anyone gone, and push the
    session when anything visible changed since `previous` (a phase reached by the clock alone,
    someone's connection). Returns the new signature, or None when the session is gone."""
    now = utcnow()
    try:
        doc = _read(session_id)
    except SharedWorkoutError:
        return None
    doc = _swept(doc, now, publish=False)
    signature = _signature(doc, now)
    if signature != previous:
        publish_session(doc, now)
    return signature


# --- rendering and publishing ----------------------------------------------------------------------

def invite_url(code: str) -> str:
    return f"{config.PUBLIC_BASE_URL}/w/{code}"


def render(doc: dict, viewer: str, now: datetime) -> dict:
    sid = doc["session_id"]
    connected = {p["user_id"]: presence.connected(sid, p["user_id"], now) for p in doc["players"]}
    return model.view(doc, viewer, now, connected=connected, invite_url=invite_url(doc["invite_code"]))


def session_message(doc: dict, viewer: str, now: datetime) -> dict:
    return {"type": "workout.session.updated", "data": render(doc, viewer, now)}


def publish_session(doc: dict, now: datetime) -> None:
    """Push the session to everyone listening. A listener who is no longer in it (they left the
    lobby), or any listener once the session is over, gets the update and then the socket closes."""
    closed = _closed(doc, now)

    def build(listener_id: str) -> list[dict]:
        messages = [session_message(doc, listener_id, now)]
        if closed or model.player(doc, listener_id) is None:
            messages.append({hub.CLOSE: 1000})
        return messages

    hub.publish(doc["session_id"], build)
    if closed:
        presence.forget(doc["session_id"])


def _publish_reps(doc: dict, me: dict, now: datetime) -> None:
    message = {"type": "workout.reps.updated", "data": {
        "session_id": doc["session_id"], "user_id": me["person"]["user_id"],
        "reps": me["reps"], "seq": me["seq"], "at": model.iso(now)}}
    hub.publish(doc["session_id"], lambda _listener: [message])


def _closed(doc: dict, now: datetime) -> bool:
    return model.phase(doc, now) in (model.EXPIRED, model.FINISHED)


def _signature(doc: dict, now: datetime) -> tuple:
    view = render(doc, doc["players"][0]["user_id"], now)
    seats = tuple((s["ready"], s["connected"], s["finished_at"], s["left_at"])
                  for s in (view["host"], view["partner"]) if s)
    return view["phase"], seats


# --- helpers ---------------------------------------------------------------------------------------

def _read(session_id: str) -> dict:
    doc = store.read(session_id) if _SESSION_ID_RE.fullmatch(session_id or "") else None
    if doc is None:
        raise _not_found()
    return doc


def _participant_session(session_id: str, user_id: str, now: datetime) -> dict:
    """The session, for someone in it (404 for anyone else), with their presence noted and anyone
    gone swept out."""
    doc = _read(session_id)
    if model.player(doc, user_id) is None:
        raise _not_found()
    presence.touch(session_id, user_id, now)
    return _swept(doc, now)


def _swept(doc: dict, now: datetime, *, publish: bool = True) -> dict:
    """End the race of every player gone for DISCONNECT_AFTER_S during the countdown or the race,
    and settle a race that has finished (the lazy half of settling: the phase is worked out on
    read, so the first read after the end settles it)."""
    if not _gone_players(doc, now) and not model.completion_due(doc, now):
        return doc

    def apply(d: dict) -> list[str] | None:
        _sweep(d, now)
        return model.mark_completed(d, now)

    out = store.update(doc["session_id"], apply)
    if out is None:
        raise _not_found()
    doc, rewarded = out
    if rewarded is not None:
        _on_completed(doc, rewarded, now)
    if publish:
        publish_session(doc, now)
    return doc


def _gone_players(doc: dict, now: datetime) -> list[dict]:
    if model.phase(doc, now) not in (model.COUNTDOWN, model.RACING):
        return []
    return [p for p in doc["players"]
            if p["left_at"] is None and p["finished_at"] is None and presence.gone(doc["session_id"], p["user_id"], now)]


def _sweep(doc: dict, now: datetime) -> None:
    for p in _gone_players(doc, now):
        model.leave(doc, p, now, reason="disconnected")


def _update_with_result(session_id: str, change, now: datetime) -> tuple[dict, object]:
    """Apply `change` under the session's lock, with the disconnect sweep before it and settling
    after it (a Finish or a leave can end the race), all in one write."""
    def apply(d: dict):
        _sweep(d, now)
        result = change(d)
        return result, model.mark_completed(d, now)

    out = store.update(session_id, apply)
    if out is None:
        raise _not_found()
    doc, (result, rewarded) = out
    if rewarded is not None:
        _on_completed(doc, rewarded, now)
    return doc, result


def _on_completed(doc: dict, rewarded: list[str], now: datetime) -> None:
    """What follows settling a race, run only by the one call that settled it (mark_completed under
    the lock), after the document is saved: the socket message, the XP awards and the notifications.
    Each is fire-and-forget; none can fail the request."""
    sid = doc["session_id"]
    players = doc["players"]
    try:
        results = [{"user": p["person"], "reps": p["reps"], "finished": p["left_at"] is None,
                    "rewarded": p["user_id"] in rewarded} for p in players]
        message = {"type": "workout.session.completed",
                   "data": {"session_id": sid, "completed_at": doc["completed_at"], "results": results}}
        hub.publish(sid, lambda _listener: [message])
        for p in players:
            if p["user_id"] in rewarded:
                xp_awards.award(
                    subject=p["user_id"], reason=xp_awards.SHARED_WORKOUT_FINISHED,
                    idempotency_key=xp_awards.shared_workout_key(sid, p["user_id"]), source_id=sid,
                    metadata={"exercise_key": doc["exercise_key"], "duration_s": doc["duration_s"], "reps": p["reps"]})
        for p in players:
            other = next((o for o in players if o is not p), None)
            score = f"you {p['reps']}" + (f", them {other['reps']}" if other else "")
            social_notify.notify(
                user_subject=p["user_id"], kind="shared_workout.finished",
                actor_subject=other["user_id"] if other else None,
                title="Your race with {actor} is over" if other else "Your shared workout is over",
                body=f"{EXERCISES[doc['exercise_key']]}: {score}.",
                data={"session_id": sid, "route": f"/workout/{sid}"},
                dedupe_key=f"shared_workout.finished:{sid}:{p['user_id']}",
            )
    except Exception:  # noqa: BLE001 — the race is settled and saved; side effects never fail a request
        log.exception("side effects of settling shared workout %s failed", sid)


def _update(session_id: str, change, now: datetime) -> dict:
    return _update_with_result(session_id, change, now)[0]


def _me(doc: dict, user_id: str) -> dict:
    me = model.player(doc, user_id)
    if me is None:
        raise _not_found()
    return me


def _check_host_lobby(doc: dict, user_id: str, now: datetime) -> None:
    me = _me(doc, user_id)
    if me["role"] != "host":
        raise _not_host()
    current = model.phase(doc, now)
    if current != model.LOBBY or me["left_at"] is not None:
        raise SharedWorkoutError(409, "not_in_lobby", "Invitations can only be sent from the lobby.", phase=current)


def _check_plausible(doc: dict, reps: int, now: datetime) -> None:
    if not model.plausible(doc, reps, now):
        raise SharedWorkoutError(422, "implausible_reps", "That's more reps than the time allows.")


# Rep reports per user over the last second, in-process (one worker, like presence).
_rep_calls: dict[str, deque] = {}
_rate_lock = threading.Lock()


def _throttle_reps(user_id: str, now: datetime) -> None:
    cutoff = now - timedelta(seconds=1)
    with _rate_lock:
        calls = _rep_calls.setdefault(user_id, deque())
        while calls and calls[0] <= cutoff:
            calls.popleft()
        if len(calls) >= REPS_RATE_PER_S:
            retry_ms = max(1, int((calls[0] - cutoff).total_seconds() * 1000))
            raise SharedWorkoutError(429, "rate_limited", "Too many rep reports. Slow down a little.",
                                     retry_after_ms=retry_ms)
        calls.append(now)
        if len(_rep_calls) > 10_000:
            for key in [k for k, q in _rep_calls.items() if not q or q[-1] <= cutoff]:
                del _rep_calls[key]


def reset_rate_limits() -> None:
    with _rate_lock:
        _rep_calls.clear()


def _check_joinable(doc: dict, now: datetime) -> None:
    current = model.phase(doc, now)
    if current != model.LOBBY:
        raise SharedWorkoutError(409, "not_joinable", "This session can't be joined any more.", phase=current)
    if len(model.seated(doc)) >= 2:
        raise _session_full()


def _ensure_free(user_id: str, now: datetime, *, except_session: str | None) -> None:
    for doc in store.open_for(user_id, now):
        if doc["session_id"] == except_session:
            continue
        doc = _swept(doc, now)
        if model.in_play_for(doc, user_id, now):
            raise SharedWorkoutError(409, "already_in_session", "You're already in a shared workout.",
                                     session_id=doc["session_id"])


def _blocked(user_id: str) -> frozenset[str]:
    try:
        return social_blocks.blocked_either_way(user_id)
    except social_blocks.BlocksUnreachable as exc:
        raise SharedWorkoutError(
            503, "blocks_unreachable",
            "Blocked members couldn't be checked right now, so the invite can't be opened. Try again in a moment.",
        ) from exc


def _refuse_if_blocked(user_id: str, doc: dict, blocked: frozenset[str]) -> None:
    # The same answer as an unknown code: a block is never revealed.
    if any(p["user_id"] in blocked for p in doc["players"] if p["user_id"] != user_id):
        raise _not_found()


def _resolve(user_id: str) -> dict:
    try:
        return social_people.resolve([user_id])[user_id]
    except social_people.SocialUnreachable as exc:
        raise SharedWorkoutError(
            503, "social_unreachable",
            "Your profile couldn't be loaded right now. Try again in a moment.",
        ) from exc


def _resolve_many(subjects: list[str]) -> dict[str, dict]:
    if not subjects:
        return {}
    try:
        return social_people.resolve(subjects)
    except social_people.SocialUnreachable as exc:
        raise SharedWorkoutError(
            503, "social_unreachable", "Your connections couldn't be loaded right now. Try again in a moment.",
        ) from exc


def _session_for_code(code: str) -> str:
    code = (code or "").strip().upper()
    session_id = store.session_id_for_code(code) if _CODE_RE.fullmatch(code) else None
    if session_id is None:
        raise _not_found()
    return session_id


def _new_code() -> str:
    return "".join(secrets.choice(INVITE_ALPHABET) for _ in range(INVITE_LENGTH))


def _not_racing(doc: dict, now: datetime) -> SharedWorkoutError:
    return SharedWorkoutError(409, "not_racing", "Your race isn't running.", phase=model.phase(doc, now))


def _session_full() -> SharedWorkoutError:
    return SharedWorkoutError(409, "session_full", "This session already has two people.")


def _not_host() -> SharedWorkoutError:
    return SharedWorkoutError(403, "not_host", "Only the host can do that.")


def _not_found() -> SharedWorkoutError:
    return SharedWorkoutError(404, "not_found", "Shared workout not found.")
