"""The shared-workout session document and its rules. Pure: no I/O, and the time is always passed in.

A session is one JSON document (stored as is; see store.py):

    {session_id, invite_code, exercise_key, duration_s, created_at, starts_at, ends_at,
     players: [{user_id, role, person, ready, reps, seq, joined_at, finished_at, left_at, left_reason}],
     invites: [{user_id, social_profile_id, person, status, invited_at, declined_at}],
     completed_at, rewards: [user_id…]}

`invites` are the host's invitations to their Partner Hunt connections (status invited | declined).
`completed_at` is set exactly once, when a race reaches `finished`; `rewards` then lists who earned
the finishing XP. Documents written before these keys existed have no `completed_at` key at all and
are never settled (they were hand-tapped races that earned nothing when they ran).

`user_id` is the login `sub` and never leaves this service; `person` is the Social PersonLite
(profile id, name, avatar, hostel) looked up when the player joined, and is what the app sees.

The phase is never stored. It is worked out from the timestamps on every read, in this order:

    not started (starts_at is null)
        every player has left               → finished   (the lobby closed)
        created LOBBY_TTL_S ago or more     → expired
        otherwise                           → lobby
    started
        ends_at passed, or every player has finished or left
                                            → finished
        before starts_at                    → countdown
        otherwise                           → racing

Blocks are checked again when someone readies up with a partner seated: a blocked pair's lobby is
closed for both (left_reason "closed"), quietly. A race that has started is never cut short by a
block; it ends on its own within five minutes.

Before the start, leaving frees the leaver's seat (they are removed; if the host leaves, the
partner becomes the host and can invite someone else). The last player to leave keeps their seat
with left_at set, which is what closes the lobby. From the countdown on, each player's race ends
on its own: their finished_at or left_at is set and the other keeps going.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from backend.shared_workouts.policy import (
    COUNTDOWN_S,
    EXERCISES,
    LOBBY_TTL_S,
    PLAUSIBLE_REPS_PER_S,
    PLAUSIBLE_REPS_SLACK,
    REP_SOURCE,
    REPS_GRACE_S,
)

LOBBY, EXPIRED, COUNTDOWN, RACING, FINISHED = "lobby", "expired", "countdown", "racing", "finished"
IN_PLAY = (LOBBY, COUNTDOWN, RACING)


# --- time ------------------------------------------------------------------------------------------

def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# --- building --------------------------------------------------------------------------------------

def new_session(session_id: str, invite_code: str, exercise_key: str, duration_s: int,
                host_id: str, host_person: dict, now: datetime) -> dict:
    return {
        "session_id": session_id,
        "invite_code": invite_code,
        "exercise_key": exercise_key,
        "duration_s": duration_s,
        "created_at": iso(now),
        "starts_at": None,
        "ends_at": None,
        "players": [new_player(host_id, "host", host_person, now)],
        "invites": [],
        "completed_at": None,
        "rewards": [],
    }


def new_player(user_id: str, role: str, person: dict, now: datetime) -> dict:
    return {
        "user_id": user_id, "role": role, "person": person, "ready": False, "reps": 0, "seq": 0,
        "joined_at": iso(now), "finished_at": None, "left_at": None, "left_reason": None,
    }


# --- reading ---------------------------------------------------------------------------------------

def player(session: dict, user_id: str) -> dict | None:
    return next((p for p in session["players"] if p["user_id"] == user_id), None)


def seated(session: dict) -> list[dict]:
    """Players who have not left."""
    return [p for p in session["players"] if p["left_at"] is None]


def expires_at(session: dict) -> datetime:
    return parse(session["created_at"]) + timedelta(seconds=LOBBY_TTL_S)


def phase(session: dict, now: datetime) -> str:
    starts_at = parse(session["starts_at"])
    players = session["players"]
    if starts_at is None:
        if all(p["left_at"] is not None for p in players):
            return FINISHED
        return EXPIRED if now >= expires_at(session) else LOBBY
    if now >= parse(session["ends_at"]) or all(p["finished_at"] or p["left_at"] for p in players):
        return FINISHED
    return COUNTDOWN if now < starts_at else RACING


def closes_at(session: dict) -> datetime:
    """The latest moment the session can still be in play (and take late rep reports). Stored next
    to the document so "is this person already in a session" is one indexed query."""
    if session["ends_at"] is not None:
        return parse(session["ends_at"]) + timedelta(seconds=REPS_GRACE_S)
    return expires_at(session)


def member_ids(session: dict) -> list[str]:
    return [p["user_id"] for p in seated(session)]


def in_play_for(session: dict, user_id: str, now: datetime) -> bool:
    """Whether `user_id` holds a seat in a session that is still lobby, countdown or racing."""
    me = player(session, user_id)
    return bool(me and me["left_at"] is None and me["finished_at"] is None and phase(session, now) in IN_PLAY)


def can_report(session: dict, me: dict, now: datetime) -> bool:
    """Rep reports and Finish: from the start until REPS_GRACE_S after the end, while the player's
    own race is still going (a player whose time simply ran out may still send their last taps)."""
    starts_at = parse(session["starts_at"])
    if starts_at is None or now < starts_at or me["left_at"] is not None:
        return False
    if now >= parse(session["ends_at"]) + timedelta(seconds=REPS_GRACE_S):
        return False
    return me["finished_at"] is None


def plausible(session: dict, reps: int, now: datetime) -> bool:
    """At most PLAUSIBLE_REPS_PER_S reps per second of race time so far, plus the slack."""
    starts_at = parse(session["starts_at"])
    if starts_at is None:
        return True
    elapsed = (min(now, parse(session["ends_at"])) - starts_at).total_seconds()
    return reps <= PLAUSIBLE_REPS_PER_S * max(elapsed, 0.0) + PLAUSIBLE_REPS_SLACK


def invite_for(session: dict, user_id: str) -> dict | None:
    return next((i for i in session.get("invites", []) if i["user_id"] == user_id), None)


def pending_invites(session: dict) -> list[dict]:
    """Invitations still waiting: not declined, and the person hasn't taken a seat."""
    seated_ids = set(member_ids(session))
    return [i for i in session.get("invites", []) if i["status"] == "invited" and i["user_id"] not in seated_ids]


def completion_due(session: dict, now: datetime) -> bool:
    """A race (it started) that has reached `finished` and was never settled."""
    return ("completed_at" in session and session["completed_at"] is None and session["starts_at"] is not None
            and phase(session, now) == FINISHED)


def finishers(session: dict) -> list[dict]:
    """Who earns the finishing XP: did not leave before the end (leaving or disconnecting both set
    left_at, and neither can happen once the race is over) and reported at least one rep."""
    return [p for p in session["players"] if p["left_at"] is None and p["reps"] >= 1]


# --- changing --------------------------------------------------------------------------------------

def set_ready(session: dict, me: dict, ready: bool, now: datetime) -> None:
    me["ready"] = ready
    players = seated(session)
    if len(players) == 2 and all(p["ready"] for p in players):
        starts_at = now + timedelta(seconds=COUNTDOWN_S)
        session["starts_at"] = iso(starts_at)
        session["ends_at"] = iso(starts_at + timedelta(seconds=session["duration_s"]))


def report(me: dict, reps: int, seq: int) -> bool:
    """Highest seq wins: a retry or a report overtaken by a later one changes nothing."""
    if seq <= me["seq"]:
        return False
    me["reps"], me["seq"] = reps, seq
    return True


def leave(session: dict, me: dict, now: datetime, reason: str = "left") -> None:
    if session["starts_at"] is None:
        others = [p for p in seated(session) if p is not me]
        if others:
            # Free the seat. Whoever stays starts over: they host (and hold the invite), and must
            # ready up again with whoever joins next.
            session["players"] = [p for p in session["players"] if p is not me]
            for p in others:
                p["role"], p["ready"] = "host", False
            return
    me["left_at"], me["left_reason"] = iso(now), reason


def close_lobby(session: dict, now: datetime, reason: str = "closed") -> None:
    """End an unstarted lobby for everyone in it at once: a block found when someone readies up
    ("closed": every player gets the same reason, so neither learns who blocked whom), or the host
    cancelling ("cancelled")."""
    for p in seated(session):
        p["left_at"], p["left_reason"], p["ready"] = iso(now), reason, False


def add_invite(session: dict, user_id: str, profile_id: str, person: dict, now: datetime) -> None:
    session.setdefault("invites", []).append({
        "user_id": user_id, "social_profile_id": profile_id, "person": person, "status": "invited",
        "invited_at": iso(now), "declined_at": None})


def decline_invite(invite: dict, now: datetime) -> None:
    if invite["status"] != "declined":
        invite["status"], invite["declined_at"] = "declined", iso(now)


def mark_completed(session: dict, now: datetime) -> list[str] | None:
    """Settle a finished race, once: returns who earned the finishing XP, or None if it was not due
    (not finished yet, never started, or already settled)."""
    if not completion_due(session, now):
        return None
    rewarded = [p["user_id"] for p in finishers(session)]
    session["completed_at"], session["rewards"] = iso(now), rewarded
    return rewarded


def join(session: dict, user_id: str, person: dict, now: datetime) -> None:
    for p in seated(session):
        p["ready"] = False  # a new partner: everyone readies up again
    session["players"].append(new_player(user_id, "partner", person, now))


# --- the app's view --------------------------------------------------------------------------------

def view(session: dict, viewer: str | None, now: datetime, *, connected: dict[str, bool],
         invite_url: str) -> dict:
    """The session as the app sees it. Login subjects never appear: people are Social PersonLites."""
    ends_at = parse(session["ends_at"])
    time_up = ends_at is not None and now >= ends_at
    # Who earned the finish XP, once settled. Also in workout.session.completed, but a client that
    # polls (or opens the race later, e.g. from the notification) never sees that event.
    rewards = set(session.get("rewards") or []) if session.get("completed_at") else None
    seats = {"host": None, "partner": None}
    for p in session["players"]:
        finished_at = p["finished_at"]
        if finished_at is None and p["left_at"] is None and time_up:
            finished_at = session["ends_at"]
        seats[p["role"]] = {
            "user": p["person"],
            "role": p["role"],
            "ready": p["ready"],
            "connected": bool(connected.get(p["user_id"])) and p["left_at"] is None,
            "reps": p["reps"],
            "seq": p["seq"],
            "finished_at": finished_at,
            "left_at": p["left_at"],
            "left_reason": p["left_reason"],
            "rewarded": None if rewards is None else p["user_id"] in rewards,
        }
    me = player(session, viewer) if viewer else None
    # Invitations are the players' business only: an invite preview (anyone with the code) sees none.
    invites = [{"user": i["person"], "status": i["status"], "invited_at": i["invited_at"]}
               for i in session.get("invites", [])] if me and me["left_at"] is None else []
    return {
        "session_id": session["session_id"],
        "invite_code": session["invite_code"],
        "invite_url": invite_url,
        "exercise": {"key": session["exercise_key"], "name": EXERCISES[session["exercise_key"]]},
        "duration_s": session["duration_s"],
        "phase": phase(session, now),
        "you": me["role"] if me else None,
        "host": seats["host"],
        "partner": seats["partner"],
        "created_at": session["created_at"],
        "expires_at": iso(expires_at(session)),
        "starts_at": session["starts_at"],
        "ends_at": session["ends_at"],
        "rep_source": REP_SOURCE,
        "invites": invites,
        "completed_at": session.get("completed_at"),
        "server_time": iso(now),
    }
