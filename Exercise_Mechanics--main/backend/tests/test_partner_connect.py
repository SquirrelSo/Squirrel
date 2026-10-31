"""Partner Hunt Connect: requests, silent declines, the reveal on accept, blocks and limits.

Each route is called by the sender, the recipient, an outsider and a blocked person, with Social up
and down. The safety properties carry most of the weight: a card stays anonymous until both say
yes, a decline is indistinguishable from silence, and a blocked pair never reaches each other.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from backend import card_ids, config, social_blocks
from backend.auth.tokens import issue_access_token
from backend.main import app
from backend.partners import connect
from backend.partners import store as prefs_store
from backend.partners.router import get_xp_gate
from backend.partners.xp_gate import FixedXPGate
from backend.tests.asgi_client import call
from backend.users.store import create_user_record, write_profile, read_profile, write_skill

T0 = datetime(2026, 10, 5, 9, 0, tzinfo=timezone.utc)
CARD_KEYS = {"card_id", "display_name", "age_band", "fitness_level", "shared_activities", "shared_times", "meet", "city"}


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def advance(self, **kw) -> None:
        self.now += timedelta(**kw)


@pytest.fixture(autouse=True)
def isolated_users(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")


@pytest.fixture
def clock(monkeypatch) -> Clock:
    c = Clock()
    monkeypatch.setattr(connect, "utcnow", lambda: c.now)
    return c


@pytest.fixture
def gate():
    gate = FixedXPGate(default_xp=500)
    app.dependency_overrides[get_xp_gate] = lambda: gate
    yield gate
    app.dependency_overrides.pop(get_xp_gate, None)


def member(first: str, *, gender="female", dob="1994-05-10", visible=True, **prefs) -> str:
    user_id = create_user_record({
        "first_name": first, "last_name": "Tester", "gender": gender, "height_cm": 170.0, "weight_kg": 65.0,
        "date_of_birth": dob, "mobile": "9990001111", "email": f"{first.lower()}@example.test",
    })["user_id"]
    write_skill(user_id, "intermediate")
    prefs_store.write_preferences(user_id, {
        "visible": visible, "activities": ["running", "yoga"], "mode": "either", "city": "Pune",
        "preferred_times": ["morning"], "partner_genders": [], "partner_age_min": 18, "partner_age_max": 60, **prefs})
    return user_id


@pytest.fixture
def people(clock, gate, fake_social):
    return {name: member(name) for name in ("Ana", "Ben", "Cy", "Dee")}


def api(method: str, user: str, path: str = "", body=None, *, owner: str | None = None):
    url = f"/api/users/{owner or user}/partner-hunt/requests{path}"
    return call(app, method, url, json=body, headers={"Authorization": f"Bearer {issue_access_token(user)[0]}"})


def card(viewer: str, other: str) -> str:
    return card_ids.card_id(card_ids.PARTNER_HUNT, viewer, other)


def send(sender: str, to: str):
    """Ask `to` by the card_id their board card carries for `sender`."""
    return api("POST", sender, "", {"card_id": card(sender, to)})


def lists(user: str) -> dict:
    r = api("GET", user)
    assert r.status == 200, r.body
    return r.json()


def code_of(r) -> str:
    return r.json()["detail"]["code"]


# --- sending ---------------------------------------------------------------------------------------

def test_a_request_carries_only_the_anonymous_card(people, fake_social):
    ana, ben = people["Ana"], people["Ben"]
    r = send(ana, ben)
    assert r.status == 201
    req = r.json()
    assert req["status"] == "pending" and req["created_at"] == "2026-10-05T09:00:00Z"
    assert req["expires_at"] == "2026-10-19T09:00:00Z"
    assert set(req["person"]) == CARD_KEYS
    assert req["person"]["display_name"] == "Ben T." and req["person"]["age_band"] == "25–34"
    assert req["person"]["shared_activities"] == ["running", "yoga"] and req["person"]["city"] == "Pune"
    assert req["person"]["card_id"] == card(ana, ben)          # the same id as on Ana's board
    for user, key in ((ben, "incoming"), (ana, "outgoing")):
        mine = lists(user)
        assert len(mine[key]) == 1 and mine["connections"] == []
        assert set(mine[key][0]["person"]) == CARD_KEYS
        raw = json.dumps(mine).lower()
        # Neither Social profile ids nor account ids (they spell the full name, "ana-tester-…").
        for leak in (fake_social.profile_id(ana), fake_social.profile_id(ben), ana, ben, "tester"):
            assert leak not in raw
    assert lists(ben)["incoming"][0]["person"]["card_id"] == card(ben, ana)
    assert lists(ben)["incoming"][0]["person"]["display_name"] == "Ana T."
    assert lists(people["Cy"]) == {"incoming": [], "outgoing": [], "connections": []}


def test_the_request_notification_names_nobody_to_social(people, fake_social):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    [note] = fake_social.notifications
    assert note == {"user_subject": ben, "kind": "partner.request", "title": "Ana T. wants to work out with you",
                    "body": "Open Partner Hunt to accept or decline.",
                    "data": {"route": "/partner-hunt", "request_id": request_id},
                    "dedupe_key": f"partner.request:{request_id}"}
    assert "actor_subject" not in note


def test_a_failed_notification_never_fails_the_request(people, fake_social):
    fake_social.notifications_fail = True
    assert send(people["Ana"], people["Ben"]).status == 201


def test_only_people_on_your_board_can_be_asked(people, fake_social):
    ana = people["Ana"]
    hidden = member("Hid", visible=False)
    nothing_shared = member("Far", activities=["cycling"])
    for target in (hidden, nothing_shared, "no-such-member", ana):
        r = send(ana, target)
        assert r.status == 404 and code_of(r) == "not_on_board"
    for raw in (card(people["Cy"], people["Ben"]), people["Ben"], "A" * 22, "../etc"):
        # Someone else's card for Ben, Ben's account id, a made-up id, a malformed one: all unknown.
        r = api("POST", ana, "", {"card_id": raw})
        assert r.status == 404 and code_of(r) == "not_on_board"
    assert api("POST", ana, "", {"to_user_id": people["Ben"]}).status == 422   # the old body is refused


@pytest.mark.parametrize("direction", ["sender_blocked", "recipient_blocked"])
def test_a_blocked_pair_looks_exactly_like_someone_not_on_the_board(people, fake_social, direction):
    ana, ben = people["Ana"], people["Ben"]
    hidden = member("Hid", visible=False)
    blocker, blocked = (ana, ben) if direction == "sender_blocked" else (ben, ana)
    fake_social.block(blocker, blocked)
    r = send(ana, ben)
    assert r.status == 404 and r.json() == send(ana, hidden).json()


def test_sending_needs_every_board_check(people, fake_social, gate):
    ana, ben = people["Ana"], people["Ben"]
    gate._xp[ana] = 10
    assert code_of(send(ana, ben)) == "xp_locked"
    gate._xp[ana] = 500
    fake_social.failure = "down"
    assert code_of(send(ana, ben)) == "blocks_unreachable"
    fake_social.failure = None
    young = member("Kid", dob="2010-01-01")
    assert code_of(send(young, ben)) == "age_restricted"


def test_nobody_can_read_or_act_on_anothers_requests(people):
    ana, ben, cy = people["Ana"], people["Ben"], people["Cy"]
    request_id = send(ana, ben).json()["request_id"]
    assert api("GET", cy, owner=ben).status == 403
    assert api("POST", cy, f"/{request_id}/accept", owner=ben).status == 403
    # Cy acting as themself on a request that isn't theirs: not found, like any unknown id.
    for path, method in ((f"/{request_id}/accept", "POST"), (f"/{request_id}/decline", "POST"), (f"/{request_id}", "DELETE")):
        r = api(method, cy, path)
        assert r.status == 404 and code_of(r) == "request_not_found"
    assert api("POST", ana, f"/{request_id}/accept").status == 404       # the sender can't accept their own
    assert api("POST", ben, "/not-an-id/accept").status == 404


# --- accepting -------------------------------------------------------------------------------------

def test_accepting_reveals_each_social_profile_to_the_other(people, fake_social, clock):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    clock.advance(hours=3)
    r = api("POST", ben, f"/{request_id}/accept")
    assert r.status == 200
    conn = r.json()
    assert conn["accepted_at"] == "2026-10-05T12:00:00Z"
    assert conn["person"]["social_profile_id"] == fake_social.profile_id(ana)
    assert set(conn["person"]) == CARD_KEYS | {"social_profile_id"}
    assert conn["person"]["card_id"] == card(ben, ana)
    seen_by_ana = lists(ana)
    assert seen_by_ana["outgoing"] == [] and seen_by_ana["incoming"] == []
    assert seen_by_ana["connections"][0]["person"]["social_profile_id"] == fake_social.profile_id(ben)
    assert lists(ben)["connections"][0]["person"]["social_profile_id"] == fake_social.profile_id(ana)
    assert lists(people["Cy"])["connections"] == []
    note = fake_social.notifications[-1]
    assert note["kind"] == "partner.accepted" and note["user_subject"] == ana and note["actor_subject"] == ben
    assert note["title"] == "{actor} accepted your Partner Hunt request"
    assert note["data"] == {"route": f"/partner-hunt/connect/{request_id}", "request_id": request_id}
    again = api("POST", ben, f"/{request_id}/accept")
    assert again.status == 200 and again.json() == conn
    assert len(fake_social.notifications) == 2
    assert code_of(send(ana, ben)) == "already_connected" and code_of(send(ben, ana)) == "already_connected"


@pytest.mark.parametrize("blocker", ["Ana", "Ben"])
def test_a_block_after_sending_hides_the_request_and_refuses_the_accept(people, fake_social, blocker):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    fake_social.block(people[blocker], ben if blocker == "Ana" else ana)
    social_blocks.clear_cache()
    assert lists(ben)["incoming"] == [] and lists(ana)["outgoing"] == []
    r = api("POST", ben, f"/{request_id}/accept")
    assert r.status == 404 and code_of(r) == "request_not_found"


def test_a_block_after_connecting_hides_the_connection(people, fake_social):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    api("POST", ben, f"/{request_id}/accept")
    fake_social.block(ana, ben)
    social_blocks.clear_cache()
    assert lists(ana)["connections"] == [] and lists(ben)["connections"] == []


def test_with_social_down_nothing_is_shown_and_nothing_accepted(people, fake_social):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    social_blocks.clear_cache()
    fake_social.failure = "down"
    for r in (api("GET", ana), api("GET", ben), api("POST", ben, f"/{request_id}/accept")):
        assert r.status == 503 and code_of(r) == "blocks_unreachable"
    fake_social.failure = None
    assert lists(ben)["incoming"][0]["request_id"] == request_id     # still pending


def test_accept_with_social_names_down_changes_nothing(people, fake_social, monkeypatch):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    monkeypatch.setattr("backend.social_people._urlopen", lambda *a, **k: (_ for _ in ()).throw(OSError("down")))
    r = api("POST", ben, f"/{request_id}/accept")
    assert r.status == 503 and code_of(r) == "social_unreachable"
    monkeypatch.setattr("backend.social_people._urlopen", fake_social)
    assert lists(ben)["incoming"][0]["request_id"] == request_id


def test_someone_no_longer_eligible_drops_out(people):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    write_profile(ana, {**read_profile(ana), "date_of_birth": None})
    assert lists(ben)["incoming"] == []
    assert api("POST", ben, f"/{request_id}/accept").status == 404


def test_an_expired_request_cannot_be_accepted(people, clock):
    request_id = send(people["Ana"], people["Ben"]).json()["request_id"]
    clock.advance(days=14)
    assert code_of(api("POST", people["Ben"], f"/{request_id}/accept")) == "request_not_found"
    assert lists(people["Ben"])["incoming"] == []


# --- declining is silent ---------------------------------------------------------------------------

def test_a_decline_looks_exactly_like_no_answer(people, clock):
    ana, ben, cy, dee = people["Ana"], people["Ben"], people["Cy"], people["Dee"]
    declined = send(ana, ben).json()["request_id"]
    unanswered = send(cy, dee).json()["request_id"]
    r = api("POST", ben, f"/{declined}/decline")
    assert r.status == 204 and r.body == b""
    assert api("POST", ben, f"/{declined}/decline").status == 204           # twice is fine
    assert lists(ben)["incoming"] == []

    def seen(sender):
        item = lists(sender)["outgoing"][0]
        return {k: v for k, v in item.items() if k not in ("request_id", "person")}

    assert seen(ana) == seen(cy) == {"status": "pending", "created_at": "2026-10-05T09:00:00Z",
                                     "expires_at": "2026-10-19T09:00:00Z"}
    assert code_of(send(ana, ben)) == code_of(send(cy, dee)) == "already_requested"
    clock.advance(days=14)
    assert seen(ana)["status"] == seen(cy)["status"] == "expired"
    too_soon = [send(ana, ben).json()["detail"], send(cy, dee).json()["detail"]]
    assert too_soon[0] == too_soon[1] == {"code": "too_soon", "message": "You can ask them again later.",
                                          "retry_after": "2026-11-04T09:00:00Z"}
    clock.advance(days=16)
    assert lists(ana)["outgoing"] == []
    assert send(ana, ben).status == 201                                     # 30 days on, they may ask again
    assert len(lists(ben)["incoming"]) == 1


def test_withdrawing_takes_a_request_back(people):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    assert api("DELETE", ana, f"/{request_id}").status == 204
    assert lists(ana)["outgoing"] == [] and lists(ben)["incoming"] == []
    assert code_of(send(ana, ben)) == "too_soon"                            # no withdraw-and-resend
    assert api("POST", ben, f"/{request_id}/accept").status == 404
    assert api("DELETE", ben, f"/{request_id}").status == 404               # only the sender takes it back


def test_withdrawing_a_declined_request_behaves_the_same(people):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    api("POST", ben, f"/{request_id}/decline")
    assert api("DELETE", ana, f"/{request_id}").status == 204
    assert lists(ana)["outgoing"] == []


def test_declining_or_withdrawing_after_accepting_is_refused(people):
    ana, ben = people["Ana"], people["Ben"]
    request_id = send(ana, ben).json()["request_id"]
    api("POST", ben, f"/{request_id}/accept")
    assert code_of(api("POST", ben, f"/{request_id}/decline")) == "already_connected"
    assert code_of(api("DELETE", ana, f"/{request_id}")) == "already_connected"


# --- one request per pair, and the rate limits -----------------------------------------------------

def test_if_they_already_asked_you_accept_theirs(people):
    ana, ben = people["Ana"], people["Ben"]
    theirs = send(ben, ana).json()["request_id"]
    r = send(ana, ben)
    assert r.status == 409 and r.json()["detail"]["request_id"] == theirs and code_of(r) == "they_asked_you"


def test_ten_new_requests_a_day_and_twenty_waiting(clock, gate, fake_social):
    ana = member("Ana")
    others = [member(f"P{i:02d}") for i in range(21)]
    for target in others[:10]:
        assert send(ana, target).status == 201
    r = send(ana, others[10])
    assert r.status == 429 and code_of(r) == "daily_limit"
    clock.advance(days=1)
    for target in others[10:20]:
        assert send(ana, target).status == 201
    clock.advance(days=1)
    r = send(ana, others[20])
    assert r.status == 429 and code_of(r) == "too_many_pending"
    api("DELETE", ana, f"/{lists(ana)['outgoing'][0]['request_id']}")
    assert send(ana, others[20]).status == 201


# --- buddies: removing a connection, and the XP for connecting ---------------------------------------

def connections_api(method: str, user: str, request_id: str, *, owner: str | None = None, token: bool = True):
    headers = {"Authorization": f"Bearer {issue_access_token(user)[0]}"} if token else {}
    return call(app, method, f"/api/users/{owner or user}/partner-hunt/connections/{request_id}", headers=headers)


def connected(a: str, b: str) -> str:
    request_id = send(a, b).json()["request_id"]
    assert api("POST", b, f"/{request_id}/accept").status == 200
    return request_id


@pytest.mark.parametrize("remover", ["Ana", "Ben"])
def test_either_side_removes_a_buddy_silently(people, fake_social, remover):
    ana, ben = people["Ana"], people["Ben"]
    request_id = connected(ana, ben)
    notes = len(fake_social.notifications)
    r = connections_api("DELETE", people[remover], request_id)
    assert r.status == 204 and r.body == b""
    assert lists(ana) == lists(ben) == {"incoming": [], "outgoing": [], "connections": []}
    assert len(fake_social.notifications) == notes                       # silent: nobody is told
    assert connections_api("DELETE", people[remover], request_id).status == 204   # twice is fine
    other = ben if remover == "Ana" else ana
    assert connections_api("DELETE", other, request_id).status == 204
    assert code_of(api("POST", ben, f"/{request_id}/accept")) == "request_not_found"


def test_removal_is_stored_with_who_and_when(people, clock):
    from backend.partners import requests_store

    request_id = connected(people["Ana"], people["Ben"])
    clock.advance(hours=1)
    connections_api("DELETE", people["Ben"], request_id)
    row = requests_store.get(request_id)
    assert row["status"] == "removed" and row["removed_by"] == people["Ben"]
    assert row["removed_at"] == clock.now and row["decided_at"] == T0


def test_only_the_two_people_can_remove_a_connection(people):
    ana, ben, cy = people["Ana"], people["Ben"], people["Cy"]
    request_id = connected(ana, ben)
    r = connections_api("DELETE", cy, request_id)
    assert r.status == 404 and code_of(r) == "connection_not_found"      # IDOR: unknown, not forbidden
    assert connections_api("DELETE", cy, request_id, owner=ana).status == 403   # someone else's path
    assert connections_api("DELETE", cy, request_id, token=False, owner=ana).status == 401
    assert connections_api("DELETE", ana, "not-an-id").status == 404
    assert connections_api("DELETE", ana, "f" * 32).status == 404
    pending = send(cy, ana).json()["request_id"]
    assert code_of(connections_api("DELETE", cy, pending)) == "connection_not_found"   # not a connection yet
    assert len(lists(ana)["connections"]) == 1


def test_after_removal_the_pairs_cooldown_applies_to_both(people, clock):
    ana, ben = people["Ana"], people["Ben"]
    request_id = connected(ana, ben)
    clock.advance(days=40)                         # long after the original request
    connections_api("DELETE", ana, request_id)
    for sender, to in ((ana, ben), (ben, ana)):
        r = send(sender, to)
        assert r.status == 429 and r.json()["detail"] == {
            "code": "too_soon", "message": "You can ask them again later.", "retry_after": "2026-12-14T09:00:00Z"}
    clock.advance(days=30)
    assert send(ben, ana).status == 201


def test_connecting_earns_each_person_buddy_xp_once_per_pair(people, fake_run_module, clock):
    ana, ben = people["Ana"], people["Ben"]
    request_id = connected(ana, ben)
    low, high = sorted((ana, ben))
    assert sorted(fake_run_module.calls, key=lambda c: c["subject"]) == sorted([
        {"subject": who, "amount": 20, "reason": "buddy_connected", "source": "exercise",
         "idempotency_key": f"buddy:{low}:{high}:{who}", "source_id": request_id} for who in (ana, ben)],
        key=lambda c: c["subject"])
    assert all(h and h.startswith("Bearer ") for h in fake_run_module.headers)
    assert api("POST", ben, f"/{request_id}/accept").status == 200          # an idempotent re-accept
    assert len(fake_run_module.calls) == 2
    # Removed and connected again later: the same keys, so the Run Module adds nothing.
    connections_api("DELETE", ana, request_id)
    clock.advance(days=31)
    connected(ben, ana)
    assert len(fake_run_module.calls) == 4 and len(fake_run_module.awards) == 2
    assert fake_run_module.total(ana) == fake_run_module.total(ben) == 20


def test_the_service_token_names_the_exercise_module(people, fake_run_module):
    from backend.auth.tokens import _b64d

    connected(people["Ana"], people["Ben"])
    payload = json.loads(_b64d(fake_run_module.headers[0].split()[1].split(".")[1]))
    assert payload["sub"] == "exercise_module" and payload["typ"] == "service"


@pytest.mark.parametrize("failure", ["down", 500, 409])
def test_a_failed_award_never_fails_the_accept(people, fake_run_module, failure):
    fake_run_module.failure = failure
    connected(people["Ana"], people["Ben"])
    assert len(lists(people["Ana"])["connections"]) == 1


def test_without_a_run_module_no_award_is_sent(people, monkeypatch):
    from backend import xp_awards

    sent = []
    monkeypatch.setattr(xp_awards, "_urlopen", lambda *a, **k: sent.append(a))
    monkeypatch.setattr(xp_awards, "_in_background", lambda send: send())
    connected(people["Ana"], people["Ben"])
    assert sent == []
