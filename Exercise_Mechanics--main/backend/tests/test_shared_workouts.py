"""Workout with Partner: the eight routes, the derived phases, the socket and the invite link.

Every route is called from each viewer — the creator, the joiner, an outsider and a blocked person —
with Social up, down and unconfigured: earlier bugs in this project hid because tests ran from one
role, or with Social off. The clock is a fixture, so expiry, the countdown, the end of a race, the
rep grace and the 30-second disconnect are exact.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import WebSocketDisconnect

from backend import social_blocks, social_publish
from backend.auth.tokens import issue_access_token
from backend.main import app
from backend.shared_workouts import hub, model, presence, router as sw_router, service, store
from backend.shared_workouts.policy import LOBBY_TTL_S
from backend.tests.asgi_client import call

HOST, JOINER, OUTSIDER, BLOCKED, OTHER = "host-1", "joiner-2", "outsider-3", "blocked-4", "other-5"
T0 = datetime(2026, 10, 5, 10, 0, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock(monkeypatch) -> Clock:
    c = Clock()
    monkeypatch.setattr(service, "utcnow", lambda: c.now)
    return c


@pytest.fixture
def social(fake_social):
    fake_social.names.update({HOST: "Asha Rao", JOINER: "Vik Mehta", OUTSIDER: "Ola Out", BLOCKED: "Bea Block"})
    return fake_social


def api(method: str, path: str, user: str | None = None, body=None, *, token: str | None = None):
    headers = {}
    if user is not None or token is not None:
        headers["Authorization"] = f"Bearer {token if token is not None else issue_access_token(user)[0]}"
    return call(app, method, path, json=body, headers=headers)


def create(user: str = HOST, exercise: str = "pushup", duration: int = 180) -> dict:
    r = api("POST", "/api/workout-sessions", user, {"exercise_key": exercise, "duration_s": duration})
    assert r.status == 201, r.body
    return r.json()


def join(session: dict, user: str = JOINER):
    return api("POST", f"/api/workout-sessions/invites/{session['invite_code']}/join", user, {})


def get(session: dict, user: str):
    return api("GET", f"/api/workout-sessions/{session['session_id']}", user)


def ready(session: dict, user: str, value: bool = True):
    return api("PUT", f"/api/workout-sessions/{session['session_id']}/ready", user, {"ready": value})


def reps(session: dict, user: str, count: int, seq: int, route: str = "reps"):
    return api("POST", f"/api/workout-sessions/{session['session_id']}/{route}", user, {"reps": count, "seq": seq})


def leave(session: dict, user: str):
    return api("POST", f"/api/workout-sessions/{session['session_id']}/leave", user, {})


def racing(clock: Clock, duration: int = 180) -> dict:
    """A session with HOST and JOINER in, both ready, the countdown over."""
    s = create(duration=duration)
    assert join(s).status == 200
    assert ready(s, HOST).status == 200
    assert ready(s, JOINER).json()["phase"] == "countdown"
    clock.advance(3)
    return s


def wait(clock: Clock, s: dict, seconds: int, users=(HOST, JOINER)) -> None:
    """Let time pass while `users` poll every 2 s, as the app does without a socket."""
    for _ in range(seconds // 2):
        clock.advance(2)
        for user in users:
            get(s, user)
    clock.advance(seconds % 2)


def code_of(r) -> str:
    return r.json()["detail"]["code"]


# --- create ----------------------------------------------------------------------------------------

def test_create_opens_a_lobby_showing_social_people_never_login_subjects(clock, social):
    s = create(duration=60)
    assert s["phase"] == "lobby" and s["you"] == "host" and s["partner"] is None
    assert s["exercise"] == {"key": "pushup", "name": "Push-up"} and s["duration_s"] == 60
    assert s["host"]["user"] == {"user_id": social.profile_id(HOST), "display_name": "Asha Rao",
                                 "avatar_url": None, "hostel": None}
    assert s["host"]["role"] == "host" and s["host"]["reps"] == 0 and s["host"]["seq"] == 0
    assert s["created_at"] == "2026-10-05T10:00:00.000Z" and s["expires_at"] == "2026-10-05T10:10:00.000Z"
    assert s["starts_at"] is None and s["ends_at"] is None
    assert s["rep_source"] == "hand_tapped" and "xp_awarded" not in s
    assert s["invite_url"].endswith(f"/w/{s['invite_code']}") and len(s["invite_code"]) == 8
    assert s["server_time"] == "2026-10-05T10:00:00.000Z"
    assert HOST not in json.dumps(s)


@pytest.mark.parametrize("body, code", [
    ({"exercise_key": "high_knee", "duration_s": 60}, "invalid_exercise"),   # timed, not a rep race
    ({"exercise_key": "plank", "duration_s": 60}, "invalid_exercise"),
    ({"exercise_key": "deadlift", "duration_s": 60}, "invalid_exercise"),
])
def test_create_refuses_anything_but_a_rep_exercise(clock, social, body, code):
    r = api("POST", "/api/workout-sessions", HOST, body)
    assert r.status == 422 and code_of(r) == code


@pytest.mark.parametrize("body", [
    {"exercise_key": "pushup", "duration_s": 120},
    {"exercise_key": "pushup", "duration_s": "180"},
    {"exercise_key": "pushup"},
    {"exercise_key": "pushup", "duration_s": 180, "target": 20},   # the old proposal's fields
    {"exercise_key": "pushup", "duration_s": 180, "sets": 1},
])
def test_create_takes_only_one_three_or_five_minutes(clock, social, body):
    assert api("POST", "/api/workout-sessions", HOST, body).status == 422


def test_every_rep_exercise_and_duration_is_accepted(clock, social):
    for i, key in enumerate(("squat", "bicep_curl_single", "bicep_curl_double", "pushup", "lunge")):
        for duration in (60, 180, 300):
            user = f"u{i}-{duration}"
            assert create(user, key, duration)["duration_s"] == duration


@pytest.mark.parametrize("failure", ["down", "timeout", 500, 404, "garbage"])
def test_create_with_social_down_is_refused_and_stores_nothing(clock, social, failure):
    social.failure = failure
    r = api("POST", "/api/workout-sessions", HOST, {"exercise_key": "pushup", "duration_s": 60})
    assert r.status == 503 and code_of(r) == "social_unreachable"
    assert store.open_for(HOST, clock.now) == []


def test_create_with_social_unconfigured_is_refused(clock):
    r = api("POST", "/api/workout-sessions", HOST, {"exercise_key": "pushup", "duration_s": 60})
    assert r.status == 503 and code_of(r) == "social_unreachable"


def test_create_needs_a_valid_token(clock, social):
    assert api("POST", "/api/workout-sessions", None, {"exercise_key": "pushup", "duration_s": 60}).status == 401
    assert api("POST", "/api/workout-sessions", None, {"exercise_key": "pushup", "duration_s": 60},
               token="not-a-token").status == 401


def test_one_unfinished_session_at_a_time(clock, social):
    s = create()
    r = api("POST", "/api/workout-sessions", HOST, {"exercise_key": "squat", "duration_s": 60})
    assert r.status == 409 and r.json()["detail"]["session_id"] == s["session_id"]
    clock.advance(LOBBY_TTL_S)            # the first lobby expired: a new one is fine
    assert create()["session_id"] != s["session_id"]


# --- who may read a session ------------------------------------------------------------------------

def test_a_session_is_readable_only_by_the_two_people_in_it(clock, social):
    social.block(BLOCKED, HOST)
    s = create()
    assert join(s).status == 200
    assert get(s, HOST).json()["you"] == "host"
    assert get(s, JOINER).json()["you"] == "partner"
    outsider, blocked, unknown = get(s, OUTSIDER), get(s, BLOCKED), api("GET", f"/api/workout-sessions/{'0' * 32}", OUTSIDER)
    assert outsider.status == blocked.status == unknown.status == 404
    assert outsider.json() == blocked.json() == unknown.json()          # nothing tells them apart
    assert api("GET", "/api/workout-sessions/../../etc", HOST).status == 404
    assert api("GET", f"/api/workout-sessions/{s['session_id']}").status == 401


def test_participants_keep_working_while_social_is_down(clock, social):
    s = create()
    assert join(s).status == 200
    assert ready(s, HOST).status == 200
    social.failure = "down"
    social_blocks.clear_cache()
    for user in (HOST, JOINER):
        r = get(s, user)
        assert r.status == 200 and r.json()["partner"]["user"]["display_name"] == "Vik Mehta"
    r = ready(s, JOINER)                    # the last step before a race: blocks must be checked
    assert r.status == 503 and code_of(r) == "blocks_unreachable"
    assert get(s, HOST).json()["partner"]["ready"] is False
    social.failure = None
    assert ready(s, JOINER).json()["phase"] == "countdown"
    social.failure = "down"
    clock.advance(3)
    assert reps(s, HOST, 1, 1).json()["accepted"] is True
    assert leave(s, JOINER).status == 200
    # …and the participants' own preview needs no block check either.
    assert api("GET", f"/api/workout-sessions/invites/{s['invite_code']}", HOST).status == 200


# --- preview ---------------------------------------------------------------------------------------

def test_preview_shows_an_outsider_the_invite(clock, social):
    s = create()
    r = api("GET", f"/api/workout-sessions/invites/{s['invite_code'].lower()}", OUTSIDER)
    assert r.status == 200
    p = r.json()
    assert p["you"] is None and p["phase"] == "lobby" and p["host"]["user"]["display_name"] == "Asha Rao"
    assert HOST not in r.text


@pytest.mark.parametrize("blocker, blocked", [(HOST, BLOCKED), (BLOCKED, HOST)])
def test_preview_and_join_look_like_an_unknown_code_to_a_blocked_person(clock, social, blocker, blocked):
    social.block(blocker, blocked)
    s = create()
    unknown = api("GET", "/api/workout-sessions/invites/ZZZZZZZZ", BLOCKED)
    for r in (api("GET", f"/api/workout-sessions/invites/{s['invite_code']}", BLOCKED), join(s, BLOCKED)):
        assert r.status == 404 and r.json() == unknown.json()
    assert get(s, HOST).json()["partner"] is None


def test_a_blocked_pair_is_refused_against_whoever_holds_the_seat_now(clock, social):
    # The host leaves; the partner becomes the host. Someone the partner blocked can't come in.
    social.block(JOINER, BLOCKED)
    s = create()
    assert join(s).status == 200
    assert leave(s, HOST).status == 200
    assert join(s, BLOCKED).status == 404
    assert join(s, OUTSIDER).status == 200


@pytest.mark.parametrize("failure", ["down", "timeout", 500, 404, "garbage"])
def test_preview_and_join_fail_closed_when_blocks_cannot_be_checked(clock, social, failure):
    s = create()
    social.failure = failure
    for r in (api("GET", f"/api/workout-sessions/invites/{s['invite_code']}", OUTSIDER), join(s, OUTSIDER)):
        assert r.status == 503 and code_of(r) == "blocks_unreachable"
    social.failure = None
    assert get(s, HOST).json()["partner"] is None


def test_preview_and_join_with_social_unconfigured_fail_closed(clock, social, monkeypatch):
    s = create()
    monkeypatch.delenv("SOCIAL_API_URL")
    assert code_of(api("GET", f"/api/workout-sessions/invites/{s['invite_code']}", OUTSIDER)) == "blocks_unreachable"
    assert code_of(join(s, OUTSIDER)) == "blocks_unreachable"


def test_unknown_and_malformed_codes_are_not_found(clock, social):
    for code in ("ZZZZZZZZ", "short", "has space", "O0O0O0O0", "x" * 200):
        assert api("GET", f"/api/workout-sessions/invites/{code}", OUTSIDER).status == 404


# --- join ------------------------------------------------------------------------------------------

def test_join_seats_the_partner(clock, social):
    s = create()
    clock.advance(30)
    r = join(s)
    assert r.status == 200
    j = r.json()
    assert j["you"] == "partner" and j["phase"] == "lobby"
    assert j["partner"]["user"]["user_id"] == social.profile_id(JOINER)
    assert get(s, HOST).json()["partner"]["user"]["display_name"] == "Vik Mehta"


def test_join_is_idempotent_for_people_already_in(clock, social):
    s = create()
    first = join(s).json()
    assert join(s).json()["partner"] == first["partner"]
    host_view = join(s, HOST)
    assert host_view.status == 200 and host_view.json()["you"] == "host"


def test_a_third_person_finds_the_session_full(clock, social):
    s = create()
    assert join(s).status == 200
    r = join(s, OUTSIDER)
    assert r.status == 409 and code_of(r) == "session_full"
    preview = api("GET", f"/api/workout-sessions/invites/{s['invite_code']}", OUTSIDER).json()
    assert preview["partner"] is not None and preview["you"] is None


def test_join_with_social_names_down_is_refused(clock, social, monkeypatch):
    s = create()
    monkeypatch.setattr("backend.social_people._urlopen", lambda *a, **k: (_ for _ in ()).throw(OSError("down")))
    r = join(s, OUTSIDER)
    assert r.status == 503 and code_of(r) == "social_unreachable"
    assert get(s, HOST).json()["partner"] is None


@pytest.mark.parametrize("setup, phase", [
    (lambda clock, s: clock.advance(LOBBY_TTL_S), "expired"),
    (lambda clock, s: leave(s, HOST), "finished"),
])
def test_only_a_lobby_can_be_joined(clock, social, setup, phase):
    s = create()
    setup(clock, s)
    r = join(s, OUTSIDER)
    assert r.status == 409 and r.json()["detail"] == {**r.json()["detail"], "code": "not_joinable", "phase": phase}


def test_a_started_race_cannot_be_joined(clock, social):
    s = racing(clock)
    r = join(s, OUTSIDER)
    assert r.status == 409 and r.json()["detail"]["phase"] == "racing"


def test_joining_while_in_another_session_is_refused(clock, social):
    mine = create(JOINER)
    s = create()
    r = join(s)
    assert r.status == 409 and r.json()["detail"]["session_id"] == mine["session_id"]


# --- ready and the countdown -----------------------------------------------------------------------

def test_both_ready_sets_a_three_second_countdown_and_the_end(clock, social):
    s = create(duration=300)
    assert join(s).status == 200
    assert ready(s, HOST).json()["phase"] == "lobby"
    clock.advance(2)
    r = ready(s, JOINER).json()
    assert r["phase"] == "countdown"
    assert r["starts_at"] == "2026-10-05T10:00:05.000Z" and r["ends_at"] == "2026-10-05T10:05:05.000Z"
    clock.advance(2.999)
    assert get(s, HOST).json()["phase"] == "countdown"
    clock.advance(0.001)
    assert get(s, HOST).json()["phase"] == "racing"
    wait(clock, s, 298)
    clock.advance(1.999)
    assert get(s, JOINER).json()["phase"] == "racing"
    clock.advance(0.001)
    done = get(s, JOINER).json()
    assert done["phase"] == "finished"
    assert done["host"]["finished_at"] == done["partner"]["finished_at"] == "2026-10-05T10:05:05.000Z"


def test_ready_alone_starts_nothing_and_can_be_switched_off(clock, social):
    s = create()
    assert ready(s, HOST).json()["host"]["ready"] is True
    assert ready(s, HOST, False).json()["host"]["ready"] is False
    assert ready(s, HOST).json()["starts_at"] is None
    j = join(s).json()
    assert j["host"]["ready"] is False      # a new partner: everyone readies up again
    assert ready(s, JOINER).json()["phase"] == "lobby"


def test_ready_is_locked_once_the_countdown_is_set(clock, social):
    s = create()
    join(s)
    ready(s, HOST)
    ready(s, JOINER)
    r = ready(s, HOST, False)
    assert r.status == 409 and code_of(r) == "already_started"


@pytest.mark.parametrize("user, status", [(OUTSIDER, 404), (BLOCKED, 404)])
def test_strangers_cannot_ready_report_complete_or_leave(clock, social, user, status):
    social.block(BLOCKED, HOST)
    s = racing(clock)
    for r in (ready(s, user), reps(s, user, 1, 1), reps(s, user, 1, 1, "complete"), leave(s, user)):
        assert r.status == status


def test_ready_after_expiry_is_refused(clock, social):
    s = create()
    clock.advance(LOBBY_TTL_S)
    r = ready(s, HOST)
    assert r.status == 409 and code_of(r) == "not_in_lobby"


def test_phases_lobby_then_expired_exactly_at_ten_minutes(clock, social):
    s = create()
    join(s)
    clock.advance(LOBBY_TTL_S - 0.001)
    assert get(s, HOST).json()["phase"] == "lobby"
    clock.advance(0.001)
    assert get(s, HOST).json()["phase"] == get(s, JOINER).json()["phase"] == "expired"


# --- blocks made after joining ---------------------------------------------------------------------

@pytest.mark.parametrize("blocker, blocked", [(HOST, JOINER), (JOINER, HOST)])
@pytest.mark.parametrize("readier", [HOST, JOINER])
def test_a_block_found_at_ready_quietly_closes_the_lobby_for_both(clock, social, blocker, blocked, readier):
    s = create()
    join(s)
    social.block(blocker, blocked)
    social_blocks.clear_cache()             # as after Exercise's 30-second cache
    r = ready(s, readier)
    assert r.status == 200
    for user in (HOST, JOINER):
        v = get(s, user).json()
        assert v["phase"] == "finished" and v["starts_at"] is None
        seats = [v["host"], v["partner"]]
        assert [p["left_reason"] for p in seats] == ["closed", "closed"]
        assert all(not p["ready"] for p in seats)
        assert "block" not in json.dumps(v).lower()
    assert create(HOST)["phase"] == create(JOINER)["phase"] == "lobby"   # both are free again


def test_ready_needs_no_block_check_alone_or_to_unready(clock, social):
    s = create()
    social.failure = "down"
    assert ready(s, HOST).status == 200      # alone: nobody to check against
    social.failure = None
    join(s)
    ready(s, JOINER)
    social.failure = "down"
    assert ready(s, JOINER, False).status == 200


def test_a_block_during_the_race_lets_the_race_finish(clock, social):
    s = racing(clock, duration=60)
    social.block(HOST, JOINER)
    social_blocks.clear_cache()
    wait(clock, s, 30)
    assert reps(s, JOINER, 10, 10).json()["accepted"] is True
    v = get(s, HOST).json()
    assert v["phase"] == "racing" and v["partner"]["left_at"] is None
    wait(clock, s, 30)
    done = get(s, JOINER).json()
    assert done["phase"] == "finished" and done["host"]["left_reason"] is None


# --- reps ------------------------------------------------------------------------------------------

def test_reps_are_refused_until_the_race_starts(clock, social):
    s = create()
    join(s)
    assert code_of(reps(s, HOST, 1, 1)) == "not_racing"
    ready(s, HOST)
    ready(s, JOINER)
    assert code_of(reps(s, HOST, 1, 1)) == "not_racing"     # countdown
    clock.advance(3)
    assert reps(s, HOST, 1, 1).json() == {"accepted": True, "reps": 1, "seq": 1}


def test_highest_seq_wins_retries_and_undo(clock, social):
    s = racing(clock)
    assert reps(s, HOST, 5, 5).json() == {"accepted": True, "reps": 5, "seq": 5}
    assert reps(s, HOST, 4, 4).json() == {"accepted": False, "reps": 5, "seq": 5}   # late, overtaken
    assert reps(s, HOST, 5, 5).json() == {"accepted": False, "reps": 5, "seq": 5}   # a retry
    assert reps(s, HOST, 4, 6).json() == {"accepted": True, "reps": 4, "seq": 6}    # undo
    seen = get(s, JOINER).json()["host"]
    assert (seen["reps"], seen["seq"]) == (4, 6)
    assert get(s, HOST).json()["partner"]["reps"] == 0


@pytest.mark.parametrize("body", [
    {"reps": -1, "seq": 1}, {"reps": 2001, "seq": 1}, {"reps": 1, "seq": 0}, {"reps": 1},
    {"reps": "3", "seq": 1}, {"reps": 1.5, "seq": 1}, {"reps": 1, "seq": 1, "client_time": "x"},
])
def test_rep_reports_are_validated(clock, social, body):
    s = racing(clock)
    assert api("POST", f"/api/workout-sessions/{s['session_id']}/reps", HOST, body).status == 422


def test_last_taps_count_for_five_seconds_after_the_end(clock, social):
    s = racing(clock, duration=60)
    clock.advance(60 + 4.999)
    assert reps(s, HOST, 30, 30).json()["accepted"] is True
    assert get(s, HOST).json()["phase"] == "finished"
    clock.advance(0.001)
    r = reps(s, HOST, 31, 31)
    assert r.status == 409 and r.json()["detail"]["phase"] == "finished"


# --- complete --------------------------------------------------------------------------------------

def test_finishing_early_ends_only_your_race(clock, social):
    s = racing(clock)
    wait(clock, s, 40)
    r = reps(s, HOST, 20, 21, "complete").json()
    assert r["host"]["finished_at"] == "2026-10-05T10:00:43.000Z" and r["host"]["reps"] == 20
    assert r["phase"] == "racing" and r["partner"]["finished_at"] is None
    assert code_of(reps(s, HOST, 21, 22)) == "not_racing"
    assert reps(s, JOINER, 9, 9).json()["accepted"] is True
    again = reps(s, HOST, 25, 30, "complete")
    assert again.status == 200 and again.json()["host"]["reps"] == 20        # already finished
    assert reps(s, JOINER, 10, 10, "complete").json()["phase"] == "finished"


def test_complete_in_the_grace_is_dated_at_the_end(clock, social):
    s = racing(clock, duration=60)
    clock.advance(62)
    r = reps(s, JOINER, 12, 12, "complete").json()
    assert r["partner"]["finished_at"] == r["ends_at"] and r["partner"]["reps"] == 12


def test_complete_before_the_start_is_refused(clock, social):
    s = create()
    join(s)
    assert code_of(reps(s, HOST, 0, 1, "complete")) == "not_racing"


# --- leave -----------------------------------------------------------------------------------------

def test_host_leaving_the_lobby_hands_it_to_the_partner(clock, social):
    s = create()
    join(s)
    ready(s, JOINER)
    gone = leave(s, HOST).json()
    assert gone["you"] is None and gone["phase"] == "lobby"
    stayed = get(s, JOINER).json()
    assert stayed["phase"] == "lobby" and stayed["you"] == "host" and stayed["partner"] is None
    assert stayed["host"]["user"]["display_name"] == "Vik Mehta" and stayed["host"]["ready"] is False
    assert get(s, HOST).status == 404                 # the leaver is no longer in it
    assert join(s, OUTSIDER).json()["you"] == "partner"   # the new host can invite someone else


def test_partner_leaving_the_lobby_frees_the_seat_and_can_come_back(clock, social):
    s = create()
    join(s)
    leave(s, JOINER)
    h = get(s, HOST).json()
    assert h["partner"] is None and h["phase"] == "lobby"
    assert join(s).json()["you"] == "partner"


def test_the_lobby_closes_only_when_everyone_has_left(clock, social):
    s = create()
    join(s)
    leave(s, HOST)
    last = leave(s, JOINER).json()
    assert last["phase"] == "finished" and last["host"]["left_at"] == "2026-10-05T10:00:00.000Z"
    assert last["host"]["left_reason"] == "left"
    assert code_of(join(s, OUTSIDER)) == "not_joinable"
    assert create(JOINER)["phase"] == "lobby"         # free to start another


def test_leaving_the_race_ends_only_your_race(clock, social):
    s = racing(clock)
    clock.advance(2)
    reps(s, HOST, 7, 7)
    clock.advance(8)
    r = leave(s, HOST).json()
    assert r["phase"] == "racing" and r["you"] == "host"
    assert r["host"]["left_at"] == "2026-10-05T10:00:13.000Z" and r["host"]["left_reason"] == "left"
    assert r["host"]["reps"] == 7 and r["host"]["connected"] is False
    assert code_of(reps(s, HOST, 8, 8)) == "not_racing"
    p = get(s, JOINER).json()
    assert p["phase"] == "racing" and p["host"]["left_at"] is not None
    assert reps(s, JOINER, 3, 3).json()["accepted"] is True
    assert leave(s, JOINER).json()["phase"] == "finished"
    assert leave(s, JOINER).status == 200              # leaving a finished session changes nothing


# --- disconnects -----------------------------------------------------------------------------------

def test_thirty_seconds_silent_during_the_race_ends_that_players_race(clock, social):
    s = racing(clock)
    for _ in range(15):                     # the joiner polls every 2 s, the host goes quiet
        clock.advance(2)
        get(s, JOINER)
    clock.advance(2)                        # 32 s since the host was last heard
    p = get(s, JOINER).json()
    assert p["host"]["left_reason"] == "disconnected" and p["host"]["connected"] is False
    assert p["partner"]["left_at"] is None and p["phase"] == "racing"
    assert code_of(reps(s, HOST, 1, 1)) == "not_racing"


def test_polling_keeps_both_players_in(clock, social):
    s = racing(clock)
    for _ in range(40):
        clock.advance(2)
        get(s, HOST)
        get(s, JOINER)
    v = get(s, HOST).json()
    assert v["host"]["left_at"] is None and v["partner"]["left_at"] is None
    assert v["host"]["connected"] and v["partner"]["connected"]


def test_nobody_is_disconnected_from_a_lobby(clock, social):
    s = create()
    join(s)
    clock.advance(9 * 60)
    v = get(s, HOST).json()
    assert v["partner"]["left_at"] is None and v["partner"]["connected"] is False


def test_a_restart_never_ends_a_race(clock, social):
    s = racing(clock)
    presence.reset()                       # what a restart forgets
    clock.advance(40)
    v = get(s, JOINER).json()
    assert v["host"]["left_at"] is None    # the host is counted as seen when first looked at


# --- XP: a flat award per finished race, never per rep, and no activity ------------------------------

def test_a_hand_tapped_race_writes_no_activity_and_xp_only_through_the_run_module(clock, social, monkeypatch,
                                                                                  fake_run_module):
    published = []
    monkeypatch.setattr(social_publish, "publish", lambda row: published.append(row))
    s = racing(clock, duration=60)
    clock.advance(10)
    reps(s, HOST, 30, 30)
    reps(s, JOINER, 28, 28)
    clock.advance(51)
    done = get(s, HOST).json()
    assert done["phase"] == "finished" and done["rep_source"] == "hand_tapped" and "xp_awarded" not in done
    assert published == []
    # The same 20 XP each, whatever the rep count: never per rep.
    assert sorted((a["subject"], a["amount"]) for a in fake_run_module.awards) == [(HOST, 20), (JOINER, 20)]
    # Social was asked for names and blocks, and told the race is over: no activity.
    assert all(path in ("/internal/v1/people/resolve", "/internal/v1/notifications")
               or path.startswith("/internal/v1/blocks/") for _, path, _ in social.requests)


# --- storage ---------------------------------------------------------------------------------------

def test_closed_sessions_are_deleted_after_a_week(clock, social):
    old = create()
    leave(old, HOST)
    clock.advance(8 * 24 * 3600)
    create()
    assert store.read(old["session_id"]) is None


# --- the socket ------------------------------------------------------------------------------------

class FakeSocket:
    def __init__(self, session_id: str, token: str) -> None:
        self.query_params = {"token": token}
        self.session_id = session_id
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.sent: list[dict] = []
        self.closed: int | None = None

    async def accept(self) -> None:
        pass

    async def receive_text(self) -> str:
        item = await self.inbox.get()
        if item is None:
            raise WebSocketDisconnect()
        return item

    async def send_json(self, value: dict) -> None:
        self.sent.append(value)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = code

    def types(self) -> list[str]:
        return [m["type"] for m in self.sent]


def _open(session_id: str, user: str | None, token: str | None = None) -> FakeSocket:
    return FakeSocket(session_id, token if token is not None else issue_access_token(user)[0])


async def _until(predicate, timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out")
        await asyncio.sleep(0.01)


@pytest.mark.parametrize("token", ["", "garbage"])
def test_socket_needs_a_token(clock, social, token):
    s = create()
    ws = _open(s["session_id"], None, token)
    asyncio.run(sw_router.session_socket(ws, s["session_id"]))
    assert ws.closed == 4401 and ws.sent == []


@pytest.mark.parametrize("user", [OUTSIDER, BLOCKED])
def test_socket_refuses_people_not_in_the_session(clock, social, user):
    s = create()
    ws = _open(s["session_id"], user)
    asyncio.run(sw_router.session_socket(ws, s["session_id"]))
    assert ws.closed == 4404 and ws.sent == []
    ws = _open("0" * 32, HOST)
    asyncio.run(sw_router.session_socket(ws, "0" * 32))
    assert ws.closed == 4404


def test_socket_sends_the_session_pongs_and_every_change(clock, social, monkeypatch):
    monkeypatch.setattr(sw_router, "SWEEP_INTERVAL_S", 0.02)
    s = create()

    async def scenario():
        host = _open(s["session_id"], HOST)
        task = asyncio.create_task(sw_router.session_socket(host, s["session_id"]))
        await _until(lambda: host.sent)
        first = host.sent[0]
        assert first["type"] == "workout.session.updated" and first["data"]["you"] == "host"
        assert first["data"]["host"]["connected"] is True

        await host.inbox.put(json.dumps({"type": "ping"}))
        await _until(lambda: "pong" in host.types())
        assert host.sent[-1]["data"] == {"server_time": "2026-10-05T10:00:00.000Z"}

        await asyncio.to_thread(service.join, s["invite_code"], JOINER)
        await _until(lambda: any(m["type"] == "workout.session.updated" and m["data"]["partner"] for m in host.sent))

        joiner = _open(s["session_id"], JOINER)
        jtask = asyncio.create_task(sw_router.session_socket(joiner, s["session_id"]))
        await _until(lambda: joiner.sent)
        assert joiner.sent[0]["data"]["you"] == "partner"

        await asyncio.to_thread(service.set_ready, s["session_id"], HOST, True)
        await asyncio.to_thread(service.set_ready, s["session_id"], JOINER, True)
        await _until(lambda: any(m["type"] == "workout.session.updated" and m["data"]["phase"] == "countdown"
                                 for m in joiner.sent))

        clock.advance(3)                     # racing begins with nobody calling anything: the sweep
        await _until(lambda: any(m["type"] == "workout.session.updated" and m["data"]["phase"] == "racing"
                                 for m in host.sent))

        await asyncio.to_thread(service.report_reps, s["session_id"], JOINER, 4, 4)
        await _until(lambda: "workout.reps.updated" in host.types())
        update = next(m for m in host.sent if m["type"] == "workout.reps.updated")["data"]
        assert update == {"session_id": s["session_id"], "user_id": social.profile_id(JOINER), "reps": 4,
                          "seq": 4, "at": "2026-10-05T10:00:03.000Z"}
        assert JOINER not in json.dumps(host.sent) and HOST not in json.dumps(joiner.sent)

        clock.advance(180)                   # time runs out: the last update, then the socket closes
        await asyncio.wait_for(asyncio.gather(task, jtask), 2)
        for ws in (host, joiner):
            assert ws.sent[-1]["data"]["phase"] == "finished" and ws.closed == 1000

    asyncio.run(scenario())
    assert hub.sessions() == []


def test_a_socket_keeps_its_player_connected_through_the_race(clock, social, monkeypatch):
    monkeypatch.setattr(sw_router, "SWEEP_INTERVAL_S", 0.02)
    s = racing(clock)

    async def scenario():
        host = _open(s["session_id"], HOST)
        task = asyncio.create_task(sw_router.session_socket(host, s["session_id"]))
        await _until(lambda: host.sent)
        clock.advance(60)                    # the joiner went silent; the host only has the socket
        await _until(lambda: any(m["type"] == "workout.session.updated"
                                 and m["data"]["partner"]["left_reason"] == "disconnected" for m in host.sent))
        last = [m for m in host.sent if m["type"] == "workout.session.updated"][-1]["data"]
        assert last["host"]["left_at"] is None and last["host"]["connected"] is True
        assert last["phase"] == "racing"
        await host.inbox.put(None)            # the app closes the socket
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())
    assert not presence.connected(s["session_id"], HOST, clock.now + timedelta(seconds=11))


def test_leaving_the_lobby_closes_the_leavers_socket(clock, social):
    s = create()
    join(s)

    async def scenario():
        joiner = _open(s["session_id"], JOINER)
        task = asyncio.create_task(sw_router.session_socket(joiner, s["session_id"]))
        await _until(lambda: joiner.sent)
        await asyncio.to_thread(service.leave, s["session_id"], JOINER)
        await asyncio.wait_for(task, 2)
        assert joiner.closed == 1000 and joiner.sent[-1]["data"]["you"] is None

    asyncio.run(scenario())


def test_a_socket_to_a_finished_session_gets_it_once_and_closes(clock, social):
    s = create()
    leave(s, HOST)
    ws = _open(s["session_id"], HOST)
    asyncio.run(sw_router.session_socket(ws, s["session_id"]))
    assert ws.types() == ["workout.session.updated"] and ws.sent[0]["data"]["phase"] == "finished"
    assert ws.closed == 1000


# --- the invite link -------------------------------------------------------------------------------

def test_invite_link_opens_the_join_screen(clock, social):
    s = create()
    r = call(app, "GET", f"/w/{s['invite_code']}", headers={"user-agent": "Mozilla/5.0 (X11; Linux)"})
    assert r.status == 200 and f"squirrelsocial://workout/join/{s['invite_code']}" in r.text
    assert "Asha" not in r.text                         # the page reveals nothing about the session
    odd = call(app, "GET", "/w/%3Cb%3Ehi", headers={"user-agent": "Mozilla/5.0 (X11; Linux)"})
    assert odd.status == 200 and "workout/join" not in odd.text and "<b>hi" not in odd.text
    android = call(app, "GET", f"/w/{s['invite_code']}", headers={"user-agent": "Mozilla/5.0 (Linux; Android 14)"})
    assert android.status == 302


def test_installed_apps_claim_invite_links():
    r = call(app, "GET", "/.well-known/apple-app-site-association")
    assert {"/": "/w/*"} in r.json()["applinks"]["details"][0]["components"]


# --- the pure rules --------------------------------------------------------------------------------

def test_phase_rules_in_order():
    person = {"user_id": "p", "display_name": "P", "avatar_url": None, "hostel": None}
    doc = model.new_session("a" * 32, "ABCDEFGH", "squat", 60, "h", person, T0)
    assert model.phase(doc, T0) == "lobby"
    assert model.phase(doc, T0 + timedelta(seconds=LOBBY_TTL_S)) == "expired"
    model.leave(doc, doc["players"][0], T0)
    assert model.phase(doc, T0) == "finished"           # the only player left: closed, not expired
