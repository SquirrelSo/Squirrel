"""Workout with Partner, second part: inviting a buddy, declining, cancelling, settling a finished
race (XP and notifications, exactly once), and the server-side checks on hand-tapped reps.

Buddies are Partner Hunt connections, so the people here are real accounts (partner_requests
references them in PostgreSQL) connected by accepted rows written straight to the store. Social and
the Run Module are the in-memory fakes; the clock is a fixture.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from backend import config, social_blocks, social_people
from backend.auth.tokens import issue_access_token
from backend.main import app
from backend.partners import requests_store
from backend.shared_workouts import hub, model, service, store
from backend.tests.asgi_client import call
from backend.users.store import create_user_record

T0 = datetime(2026, 10, 5, 10, 0, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture(autouse=True)
def isolated_users(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")


@pytest.fixture
def clock(monkeypatch) -> Clock:
    c = Clock()
    monkeypatch.setattr(service, "utcnow", lambda: c.now)
    return c


def account(first: str) -> str:
    return create_user_record({
        "first_name": first, "last_name": "Tester", "gender": "female", "height_cm": 170.0, "weight_kg": 65.0,
        "date_of_birth": "1994-05-10", "mobile": "9990001111", "email": f"{first.lower()}@example.test",
    })["user_id"]


def befriend(a: str, b: str, status: str = "accepted") -> str:
    request_id = uuid.uuid4().hex
    with requests_store.transaction() as tx:
        tx.insert({"request_id": request_id, "from_user": a, "to_user": b, "status": status,
                   "created_at": T0 - timedelta(days=1), "expires_at": T0 + timedelta(days=13),
                   "decided_at": T0 - timedelta(hours=1)})
    return request_id


@pytest.fixture
def people(clock, fake_social, fake_run_module) -> dict[str, str]:
    """Host is connected with Bud, Kim, Lee and Max; Stranger is connected with nobody."""
    ids = {name: account(name) for name in ("Host", "Bud", "Kim", "Lee", "Max", "Stranger")}
    for name in ("Bud", "Kim", "Lee", "Max"):
        befriend(ids["Host"], ids[name]) if name != "Kim" else befriend(ids[name], ids["Host"])
    fake_social.names.update({ids["Host"]: "Asha Rao", ids["Bud"]: "Vik Mehta"})
    return ids


@pytest.fixture
def events(monkeypatch) -> list[dict]:
    """Every socket message the hub is asked to publish, as the first player would get it."""
    seen: list[dict] = []
    real = hub.publish

    def record(session_id, build):
        doc = store.read(session_id)
        seen.extend(m for m in build(doc["players"][0]["user_id"]) if "type" in m)
        real(session_id, build)

    monkeypatch.setattr(hub, "publish", record)
    return seen


def api(method: str, path: str, user: str | None = None, body=None):
    headers = {"Authorization": f"Bearer {issue_access_token(user)[0]}"} if user else {}
    return call(app, method, path, json=body, headers=headers)


def create(user: str, duration: int = 60) -> dict:
    r = api("POST", "/api/workout-sessions", user, {"exercise_key": "pushup", "duration_s": duration})
    assert r.status == 201, r.body
    return r.json()


def invite(s: dict, user: str, profile_id: str):
    return api("POST", f"/api/workout-sessions/{s['session_id']}/invite", user, {"social_profile_id": profile_id})


def join(s: dict, user: str):
    return api("POST", f"/api/workout-sessions/invites/{s['invite_code']}/join", user, {})


def decline(s: dict, user: str):
    return api("POST", f"/api/workout-sessions/invites/{s['invite_code']}/decline", user, {})


def cancel(s: dict, user: str):
    return api("POST", f"/api/workout-sessions/{s['session_id']}/cancel", user, {})


def get(s: dict, user: str):
    return api("GET", f"/api/workout-sessions/{s['session_id']}", user)


def ready(s: dict, user: str):
    return api("PUT", f"/api/workout-sessions/{s['session_id']}/ready", user, {"ready": True})


def reps(s: dict, user: str, count: int, seq: int, route: str = "reps"):
    return api("POST", f"/api/workout-sessions/{s['session_id']}/{route}", user, {"reps": count, "seq": seq})


def leave(s: dict, user: str):
    return api("POST", f"/api/workout-sessions/{s['session_id']}/leave", user, {})


def code_of(r) -> str:
    return r.json()["detail"]["code"]


def racing(clock: Clock, host: str, partner: str, duration: int = 60) -> dict:
    s = create(host, duration)
    assert join(s, partner).status == 200
    ready(s, host)
    assert ready(s, partner).json()["phase"] == "countdown"
    clock.advance(3)
    return s


def kinds(fake_social, kind: str) -> list[dict]:
    return [n for n in fake_social.notifications if n["kind"] == kind]


# --- invite ----------------------------------------------------------------------------------------

def test_the_host_invites_a_buddy_who_is_notified(people, fake_social, events):
    host, bud = people["Host"], people["Bud"]
    s = create(host)
    r = invite(s, host, fake_social.profile_id(bud))
    assert r.status == 200
    view = r.json()
    assert view["invites"] == [{"user": {"user_id": fake_social.profile_id(bud), "display_name": "Vik Mehta",
                                         "avatar_url": None, "hostel": None},
                                "status": "invited", "invited_at": "2026-10-05T10:00:00.000Z"}]
    assert bud not in r.text and host not in r.text                        # login ids never leave
    [note] = kinds(fake_social, "shared_workout.invited")
    assert note == {"user_subject": bud, "kind": "shared_workout.invited", "actor_subject": host,
                    "title": "{actor} invited you to a shared workout",
                    "body": "Push-up race, 1 min. Join before the lobby closes.",
                    "data": {"code": s["invite_code"], "session_id": s["session_id"],
                             "route": f"/workout/join/{s['invite_code']}"},
                    "dedupe_key": f"shared_workout.invited:{s['session_id']}:{bud}"}
    invited = [e for e in events if e["type"] == "workout.session.invited"]
    assert invited == [{"type": "workout.session.invited", "data": {
        "session_id": s["session_id"], "invite": view["invites"][0]}}]
    # The invite preview (anyone with the code) shows no invitations; the invitee joins as usual.
    preview = api("GET", f"/api/workout-sessions/invites/{s['invite_code']}", bud)
    assert preview.status == 200 and preview.json()["invites"] == []
    assert join(s, bud).json()["you"] == "partner"
    assert get(s, bud).json()["invites"][0]["status"] == "invited"


def test_inviting_is_idempotent_per_person(people, fake_social):
    host, bud, kim = people["Host"], people["Bud"], people["Kim"]
    s = create(host)
    first = invite(s, host, fake_social.profile_id(bud)).json()
    again = invite(s, host, fake_social.profile_id(bud).upper())
    assert again.status == 200 and again.json()["invites"] == first["invites"]
    assert invite(s, host, fake_social.profile_id(kim)).status == 200   # a connection they were asked for
    assert len(kinds(fake_social, "shared_workout.invited")) == 2


def test_only_buddies_can_be_invited(people, fake_social):
    host = people["Host"]
    s = create(host)
    for target in (people["Stranger"], host):
        r = invite(s, host, fake_social.profile_id(target))
        assert r.status == 403 and code_of(r) == "not_a_buddy"
    assert code_of(invite(s, host, str(uuid.uuid4()))) == "not_a_buddy"
    # A request still waiting, or a removed connection, is not a buddy.
    befriend(host, people["Stranger"], status="pending")
    assert code_of(invite(s, host, fake_social.profile_id(people["Stranger"]))) == "not_a_buddy"
    stranger_s = create(people["Stranger"])
    assert code_of(invite(stranger_s, people["Stranger"], fake_social.profile_id(host))) == "not_a_buddy"
    assert fake_social.notifications == []


@pytest.mark.parametrize("direction", ["host_blocked_bud", "bud_blocked_host"])
def test_a_blocked_buddy_reads_as_not_a_buddy(people, fake_social, direction):
    host, bud = people["Host"], people["Bud"]
    fake_social.block(*((host, bud) if direction == "host_blocked_bud" else (bud, host)))
    s = create(host)
    r = invite(s, host, fake_social.profile_id(bud))
    assert r.status == 403 and code_of(r) == "not_a_buddy"
    assert fake_social.notifications == []


@pytest.mark.parametrize("failure", ["down", "timeout", 500, "garbage"])
def test_invites_fail_closed_when_blocks_cannot_be_checked(people, fake_social, failure):
    host = people["Host"]
    s = create(host)
    social_blocks.clear_cache()
    fake_social.failure = failure
    r = invite(s, host, fake_social.profile_id(people["Bud"]))
    assert r.status == 503 and code_of(r) == "blocks_unreachable"
    fake_social.failure = None
    assert get(s, host).json()["invites"] == []


def test_invites_need_social_names(people, fake_social, monkeypatch):
    host = people["Host"]
    s = create(host)

    def down(_subjects):
        raise social_people.SocialUnreachable("down")

    monkeypatch.setattr(social_people, "resolve", down)
    r = invite(s, host, fake_social.profile_id(people["Bud"]))
    assert r.status == 503 and code_of(r) == "social_unreachable"


def test_at_most_three_invitations_wait_at_once(people, fake_social):
    host = people["Host"]
    s = create(host)
    for name in ("Bud", "Kim", "Lee"):
        assert invite(s, host, fake_social.profile_id(people[name])).status == 200
    r = invite(s, host, fake_social.profile_id(people["Max"]))
    assert r.status == 429 and code_of(r) == "too_many_invites"
    assert decline(s, people["Kim"]).status == 204                         # a declined one stops waiting
    assert invite(s, host, fake_social.profile_id(people["Max"])).status == 200
    assert len(get(s, host).json()["invites"]) == 4


def test_only_the_host_invites_and_only_from_an_open_lobby(people, fake_social, clock):
    host, bud, kim = people["Host"], people["Bud"], people["Kim"]
    s = create(host)
    join(s, bud)
    r = invite(s, bud, fake_social.profile_id(kim))
    assert r.status == 403 and code_of(r) == "not_host"
    r = invite(s, host, fake_social.profile_id(kim))
    assert r.status == 409 and code_of(r) == "session_full"
    assert invite(s, people["Stranger"], fake_social.profile_id(kim)).status == 404   # not in it
    ready(s, host)
    ready(s, bud)
    r = invite(s, host, fake_social.profile_id(kim))
    assert r.status == 409                                                  # started: no seat for anyone
    other = create(kim)
    clock.advance(10 * 60)
    r = invite(other, kim, fake_social.profile_id(host))
    assert r.status == 409 and code_of(r) == "not_in_lobby" and r.json()["detail"]["phase"] == "expired"


# --- decline ---------------------------------------------------------------------------------------

def test_declining_is_silent_and_shows_only_in_the_session(people, fake_social, clock):
    host, bud = people["Host"], people["Bud"]
    s = create(host)
    invite(s, host, fake_social.profile_id(bud))
    notes = len(fake_social.notifications)
    clock.advance(5)
    r = decline(s, bud)
    assert r.status == 204 and r.body == b""
    assert decline(s, bud).status == 204                                    # twice is fine
    assert len(fake_social.notifications) == notes                         # nobody is told
    [seen] = get(s, host).json()["invites"]
    assert seen["status"] == "declined"
    assert store.read(s["session_id"])["invites"][0]["declined_at"] == "2026-10-05T10:00:05.000Z"
    assert invite(s, host, fake_social.profile_id(bud)).json()["invites"][0]["status"] == "declined"


def test_only_an_invited_person_can_decline(people, fake_social):
    host = people["Host"]
    s = create(host)
    for user in (people["Kim"], people["Stranger"], host):
        r = decline(s, user)
        assert r.status == 404 and code_of(r) == "not_found"
    assert api("POST", "/api/workout-sessions/invites/ZZZZZZZZ/decline", people["Kim"], {}).status == 404
    assert api("POST", "/api/workout-sessions/invites/bad/decline", people["Kim"], {}).status == 404


# --- cancel ----------------------------------------------------------------------------------------

def test_the_host_cancels_the_lobby_for_everyone(people, events):
    host, bud = people["Host"], people["Bud"]
    s = create(host)
    join(s, bud)
    r = cancel(s, host)
    assert r.status == 200
    view = r.json()
    assert view["phase"] == "finished"
    assert view["host"]["left_reason"] == view["partner"]["left_reason"] == "cancelled"
    assert get(s, bud).json()["phase"] == "finished"
    assert [e["type"] for e in events][-2:] == ["workout.session.cancelled", "workout.session.updated"]
    assert cancel(s, host).status == 200                                    # twice is fine
    assert code_of(join(s, people["Kim"])) == "not_joinable"
    assert create(bud)["phase"] == "lobby"                                  # both are free again
    assert view["completed_at"] is None


def test_only_the_host_cancels_and_never_after_the_start(people, clock, fake_run_module):
    host, bud = people["Host"], people["Bud"]
    s = create(host)
    join(s, bud)
    r = cancel(s, bud)
    assert r.status == 403 and code_of(r) == "not_host"
    assert cancel(s, people["Stranger"]).status == 404
    ready(s, host)
    ready(s, bud)
    r = cancel(s, host)                                                     # the countdown is on
    assert r.status == 409 and code_of(r) == "already_started"
    clock.advance(3)
    assert code_of(cancel(s, host)) == "already_started"
    assert get(s, bud).json()["phase"] == "racing"


def test_an_expired_lobby_cannot_be_cancelled(people, clock):
    s = create(people["Host"])
    clock.advance(10 * 60)
    r = cancel(s, people["Host"])
    assert r.status == 409 and code_of(r) == "not_in_lobby"


# --- settling a finished race ----------------------------------------------------------------------

def test_each_finishing_player_earns_the_award_once(people, fake_social, fake_run_module, clock, events):
    host, bud = people["Host"], people["Bud"]
    s = racing(clock, host, bud)
    clock.advance(10)
    reps(s, host, 12, 1)
    reps(s, bud, 9, 1)
    clock.advance(50)                                                       # time is up
    view = get(s, host).json()
    assert view["phase"] == "finished" and view["completed_at"] == "2026-10-05T10:01:03.000Z"
    sid = s["session_id"]
    assert sorted(fake_run_module.calls, key=lambda c: c["subject"]) == sorted([
        {"subject": who, "amount": 20, "reason": "shared_workout_finished", "source": "exercise",
         "idempotency_key": f"shared:{sid}:{who}", "source_id": sid,
         "metadata": {"exercise_key": "pushup", "duration_s": 60, "reps": n}} for who, n in ((host, 12), (bud, 9))],
        key=lambda c: c["subject"])
    finished = kinds(fake_social, "shared_workout.finished")
    assert sorted(n["user_subject"] for n in finished) == sorted([host, bud])
    mine = next(n for n in finished if n["user_subject"] == host)
    assert mine == {"user_subject": host, "kind": "shared_workout.finished", "actor_subject": bud,
                    "title": "Your race with {actor} is over", "body": "Push-up: you 12, them 9.",
                    "data": {"session_id": sid, "route": f"/workout/{sid}"},
                    "dedupe_key": f"shared_workout.finished:{sid}:{host}"}
    completed = [e for e in events if e["type"] == "workout.session.completed"]
    assert len(completed) == 1 and completed[0]["data"]["completed_at"] == view["completed_at"]
    assert [(r["reps"], r["finished"], r["rewarded"]) for r in completed[0]["data"]["results"]] == [
        (12, True, True), (9, True, True)]
    # Reading again, the grace, the sweep, a late Finish: nothing more.
    clock.advance(3)
    reps(s, bud, 10, 2, "complete")
    get(s, bud)
    clock.advance(10)
    assert service.finalise_due() == 0
    assert len(fake_run_module.calls) == 2 and len(kinds(fake_social, "shared_workout.finished")) == 2
    assert len([e for e in events if e["type"] == "workout.session.completed"]) == 1


def test_leavers_and_zero_rep_players_earn_nothing(people, fake_run_module, clock):
    host, bud, kim, lee = people["Host"], people["Bud"], people["Kim"], people["Lee"]
    s = racing(clock, host, bud)
    clock.advance(5)
    reps(s, bud, 8, 1)
    leave(s, bud)                                                           # left with reps
    clock.advance(60)
    assert get(s, host).json()["completed_at"] is not None                  # host stayed, but no reps
    assert fake_run_module.calls == []
    assert store.read(s["session_id"])["rewards"] == []
    t = racing(clock, kim, lee)                                             # one disconnects
    clock.advance(5)
    reps(t, kim, 6, 1)
    for _ in range(20):
        clock.advance(2)
        get(t, lee)                                                         # Kim went quiet
    reps(t, lee, 30, 1)
    clock.advance(30)
    get(t, lee)
    assert [c["subject"] for c in fake_run_module.calls] == [lee]


def test_duplicate_completion_never_awards_twice(people, fake_social, fake_run_module, clock):
    host, bud = people["Host"], people["Bud"]
    s = racing(clock, host, bud)
    clock.advance(10)
    first = reps(s, host, 10, 1, "complete")
    assert first.status == 200 and first.json()["completed_at"] is None     # the partner is still racing
    assert fake_run_module.calls == []
    done = reps(s, bud, 11, 1, "complete").json()                           # the last one in settles it
    assert done["phase"] == "finished" and done["completed_at"] == "2026-10-05T10:00:13.000Z"
    for user in (host, bud, host):
        again = reps(s, user, 12, 5, "complete")
        assert again.status == 200 and again.json()["completed_at"] == done["completed_at"]
    assert sorted(c["subject"] for c in fake_run_module.calls) == sorted([host, bud])
    assert len(kinds(fake_social, "shared_workout.finished")) == 2


def test_the_session_view_says_who_was_rewarded_once_settled(people, fake_social, fake_run_module, clock):
    """A polling client (or one opening the race later) learns its reward from GET, not only the socket."""
    host, bud = people["Host"], people["Bud"]
    s = racing(clock, host, bud)
    clock.advance(10)
    racing_view = reps(s, host, 10, 1, "complete").json()
    assert racing_view["host"]["rewarded"] is None and racing_view["partner"]["rewarded"] is None
    reps(s, bud, 0, 1, "complete")                                          # no reps: finishes, earns nothing
    settled = get(s, host).json()
    assert settled["completed_at"] is not None
    assert settled["host"]["rewarded"] is True and settled["partner"]["rewarded"] is False
    assert get(s, bud).json()["partner"]["rewarded"] is False


def test_an_abandoned_race_is_settled_by_the_sweep(people, fake_run_module, fake_social, clock):
    host, bud = people["Host"], people["Bud"]
    s = racing(clock, host, bud)
    clock.advance(20)
    reps(s, host, 15, 1)
    reps(s, bud, 14, 1)
    clock.advance(40)                                                       # both apps closed; nobody reads
    assert service.finalise_due() == 0                                      # rep reports may still come in
    assert store.read(s["session_id"])["completed_at"] is None
    clock.advance(5)                                                        # ends_at + the grace
    assert service.finalise_due() == 1
    doc = store.read(s["session_id"])
    assert doc["completed_at"] == "2026-10-05T10:01:08.000Z" and sorted(doc["rewards"]) == sorted([host, bud])
    assert sorted(c["subject"] for c in fake_run_module.calls) == sorted([host, bud])
    assert service.finalise_due() == 0
    assert get(s, host).json()["completed_at"] == doc["completed_at"]
    assert len(fake_run_module.calls) == 2 and len(kinds(fake_social, "shared_workout.finished")) == 2


def test_a_race_is_settled_lazily_on_the_first_read_after_the_end(people, fake_run_module, clock):
    host, bud = people["Host"], people["Bud"]
    s = racing(clock, host, bud)
    clock.advance(5)
    reps(s, bud, 3, 1)
    clock.advance(60)
    assert store.read(s["session_id"])["completed_at"] is None              # computed phase: nothing stored yet
    assert get(s, bud).json()["completed_at"] == "2026-10-05T10:01:08.000Z"
    assert [c["subject"] for c in fake_run_module.calls] == [bud]


def test_creating_a_session_settles_races_left_behind(people, fake_run_module, clock):
    host, bud = people["Host"], people["Bud"]
    s = racing(clock, host, bud)
    clock.advance(5)
    reps(s, host, 4, 1)
    clock.advance(70)
    create(people["Kim"])                                                   # housekeeping on create
    assert [c["subject"] for c in fake_run_module.calls] == [host]


def test_lobbies_and_sessions_from_before_settling_are_never_settled(people, fake_run_module, fake_social, clock):
    host, bud = people["Host"], people["Bud"]
    closed = create(host)
    leave(closed, host)                                                     # a lobby that closed: no race
    s = racing(clock, host, bud)
    clock.advance(5)
    reps(s, host, 4, 1)

    def legacy(d):
        del d["completed_at"]

    store.update(s["session_id"], legacy)                                  # written before this change
    clock.advance(70)
    assert service.finalise_due() == 0 and get(s, host).json()["completed_at"] is None
    assert fake_run_module.calls == [] and kinds(fake_social, "shared_workout.finished") == []


def test_a_failing_run_module_never_fails_the_race(people, fake_run_module, clock):
    fake_run_module.failure = "down"
    s = racing(clock, people["Host"], people["Bud"])
    clock.advance(5)
    reps(s, people["Host"], 4, 1)
    r = reps(s, people["Host"], 5, 2, "complete")
    assert r.status == 200
    assert reps(s, people["Bud"], 0, 1, "complete").json()["completed_at"] is not None


def test_without_a_run_module_the_race_settles_without_awards(people, monkeypatch, clock):
    from backend import xp_awards

    monkeypatch.delenv("RUN_MODULE_URL")
    sent = []
    monkeypatch.setattr(xp_awards, "_urlopen", lambda *a, **k: sent.append(a))
    s = racing(clock, people["Host"], people["Bud"])
    clock.advance(5)
    reps(s, people["Host"], 4, 1)
    clock.advance(60)
    assert get(s, people["Host"]).json()["completed_at"] is not None and sent == []


# --- anti-cheat ------------------------------------------------------------------------------------

def test_implausible_rep_totals_are_refused(people, clock):
    host, bud = people["Host"], people["Bud"]
    s = racing(clock, host, bud)
    r = reps(s, host, 6, 1)                                                 # 0 s in: up to 5
    assert r.status == 422 and code_of(r) == "implausible_reps"
    assert reps(s, host, 5, 1).json()["accepted"] is True
    clock.advance(10)                                                       # 10 s in: up to 45
    assert code_of(reps(s, host, 46, 2)) == "implausible_reps"
    assert reps(s, host, 45, 2).json() == {"accepted": True, "reps": 45, "seq": 2}
    assert code_of(reps(s, bud, 46, 1, "complete")) == "implausible_reps"
    assert get(s, bud).json()["partner"]["finished_at"] is None             # nothing was saved
    clock.advance(54)                                                       # in the grace: capped at the end
    assert code_of(reps(s, host, 246, 3)) == "implausible_reps"
    assert reps(s, host, 245, 3).json()["accepted"] is True


def test_rep_reports_are_rate_limited_per_person(people, clock):
    host, bud = people["Host"], people["Bud"]
    s = racing(clock, host, bud)
    clock.advance(5)
    for seq in range(1, 6):
        assert reps(s, host, seq, seq).status == 200
    r = reps(s, host, 6, 6)
    assert r.status == 429 and code_of(r) == "rate_limited" and r.json()["detail"]["retry_after_ms"] > 0
    assert reps(s, bud, 1, 1).status == 200                                 # per person
    clock.advance(1)
    assert reps(s, host, 6, 6).json()["accepted"] is True
    assert reps(s, host, 7, 7, "complete").status == 200                    # Finish isn't throttled


def test_highest_seq_still_wins(people, clock):
    s = racing(clock, people["Host"], people["Bud"])
    clock.advance(5)
    assert reps(s, people["Host"], 9, 3).json()["accepted"] is True
    assert reps(s, people["Host"], 4, 2).json() == {"accepted": False, "reps": 9, "seq": 3}


# --- auth and payloads -----------------------------------------------------------------------------

def test_every_new_route_needs_a_valid_token(people, fake_social):
    s = create(people["Host"])
    body = {"social_profile_id": fake_social.profile_id(people["Bud"])}
    for method, path, payload in (
        ("POST", f"/api/workout-sessions/{s['session_id']}/invite", body),
        ("POST", f"/api/workout-sessions/invites/{s['invite_code']}/decline", {}),
        ("POST", f"/api/workout-sessions/{s['session_id']}/cancel", {}),
    ):
        assert call(app, method, path, json=payload).status == 401
        assert call(app, method, path, json=payload, headers={"Authorization": "Bearer nope"}).status == 401


@pytest.mark.parametrize("body", [
    {}, {"social_profile_id": ""}, {"social_profile_id": "not-a-uuid"}, {"social_profile_id": 12},
    {"social_profile_id": "a" * 36}, {"social_profile_id": str(uuid.uuid4()), "message": "hi"},
    {"subject": "host"},
])
def test_invite_payloads_are_validated(people, body):
    s = create(people["Host"])
    assert api("POST", f"/api/workout-sessions/{s['session_id']}/invite", people["Host"], body).status == 422


# --- the pure rules --------------------------------------------------------------------------------

def test_settling_rules():
    person = {"user_id": "p", "display_name": "P", "avatar_url": None, "hostel": None}
    doc = model.new_session("a" * 32, "ABCDEFGH", "squat", 60, "h", person, T0)
    model.join(doc, "j", person, T0)
    assert model.mark_completed(doc, T0 + timedelta(hours=1)) is None       # never started
    model.set_ready(doc, doc["players"][0], True, T0)
    model.set_ready(doc, doc["players"][1], True, T0)
    assert model.mark_completed(doc, T0 + timedelta(seconds=30)) is None    # still racing
    doc["players"][0]["reps"] = 3
    assert model.mark_completed(doc, T0 + timedelta(seconds=63)) == ["h"]
    assert model.mark_completed(doc, T0 + timedelta(seconds=99)) is None    # once
    assert model.plausible(doc, 5, T0) and not model.plausible(doc, 6, T0)
    assert model.plausible(doc, 4 * 60 + 5, T0 + timedelta(hours=1))
