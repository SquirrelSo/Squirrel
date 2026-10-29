"""ProximityEngine — rotating ids, sighting validation, confirmation, expiry, notifications, opt-out.

A fake clock drives time so rotation windows, dwell and TTLs are exercised deterministically.
"""

from __future__ import annotations

import pytest

from backend.nearby import protocol as P
from backend.nearby import proximity as X
from backend.nearby.engine import Detection, ProximityEngine, SessionError
from backend.nearby.notifications import PAIR_NOTIFY_COOLDOWN_SECONDS, USER_NOTIFY_COOLDOWN_SECONDS

T0 = 1_800_000_000.0 - (1_800_000_000.0 % P.ROTATION_SECONDS) + 60   # 1 min into a window


class Clock:
    def __init__(self, t: float = T0):
        self.t = t

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def enabled():
    return {"alice": True, "bob": True, "carol": True}


@pytest.fixture
def engine(clock, enabled):
    return ProximityEngine(is_enabled=lambda u: enabled.get(u, False), clock=clock)


def _current_id(session: dict, clock: Clock) -> str:
    return next(e["ble_id"] for e in session["ble_ids"]
                if e["valid_from"] <= _iso(clock.t) < e["valid_until"])


def _iso(ts: float) -> str:
    from backend.nearby.engine import iso
    return iso(ts)


def _sit_together(engine, clock, observer, obs_session, target_id, *, rssi=-58, times=(0, 30, 60)):
    start = clock.t
    for dt in times:
        clock.t = start + dt
        engine.ingest(observer, obs_session, [Detection(target_id, clock.t, rssi)])
    return clock.t


def _pair(engine, clock):
    a = engine.open_session("alice", "ios")
    b = engine.open_session("bob", "android")
    return a, b


# --- rotating ids ------------------------------------------------------------

def test_session_issues_rotating_random_ids(engine, clock):
    s = engine.open_session("alice", "ios")
    ids = [e["ble_id"] for e in s["ble_ids"]]
    assert len(ids) == P.IDS_PER_ISSUE and len(set(ids)) == len(ids)
    assert all(len(i) == P.BLE_ID_BYTES * 2 and "alice" not in i for i in ids)
    assert s["service_uuid"] == P.SERVICE_UUID and s["rotation_seconds"] == P.ROTATION_SECONDS


def test_reopening_a_session_keeps_already_issued_ids(engine, clock):
    s1 = engine.open_session("alice", "ios")
    clock.t += P.ROTATION_SECONDS
    s2 = engine.open_session("alice", "ios", s1["device_session"])
    assert s2["device_session"] == s1["device_session"]
    assert s2["ble_ids"][0]["ble_id"] == s1["ble_ids"][1]["ble_id"]   # now-current window id unchanged
    assert len(s2["ble_ids"]) == P.IDS_PER_ISSUE


def test_foreign_session_id_is_not_reused(engine):
    s1 = engine.open_session("alice", "ios")
    s2 = engine.open_session("bob", "ios", s1["device_session"])
    assert s2["device_session"] != s1["device_session"]


def test_session_cap_evicts_oldest(engine, clock):
    first = engine.open_session("alice", "ios")
    for _ in range(3):
        clock.t += 1
        engine.open_session("alice", "ios")
    with pytest.raises(SessionError):
        engine.ingest("alice", first["device_session"], [])


# --- sighting validation -----------------------------------------------------

def test_unknown_self_future_stale_and_duplicate_are_ignored(engine, clock):
    a, b = _pair(engine, clock)
    bob_id, alice_id = _current_id(b, clock), _current_id(a, clock)
    r = engine.ingest("alice", a["device_session"], [
        Detection("00" * P.BLE_ID_BYTES, clock.t, -50),
        Detection(alice_id, clock.t, -50),
        Detection(bob_id, clock.t + 3600, -50),
        Detection(bob_id, clock.t - P.MAX_DETECTION_AGE_SECONDS - 1, -50),
        Detection(bob_id, clock.t, -50),
        Detection(bob_id, clock.t - 1, -50),
    ])
    assert r["accepted"] == 1
    assert r["ignored"] == {"unknown": 1, "self": 1, "future": 1, "stale": 1, "duplicate": 1}


def test_id_replayed_after_its_window_does_not_resolve(engine, clock):
    a, b = _pair(engine, clock)
    old_bob = _current_id(b, clock)
    clock.t += 2 * P.ROTATION_SECONDS
    engine.open_session("alice", "ios", a["device_session"])
    r = engine.ingest("alice", a["device_session"], [Detection(old_bob, clock.t, -50)])
    assert r["accepted"] == 0 and r["ignored"] == {"unknown": 1}


def test_ingest_requires_callers_own_session(engine, clock):
    a, b = _pair(engine, clock)
    with pytest.raises(SessionError):
        engine.ingest("alice", b["device_session"], [])


def test_opted_out_target_is_unknown(engine, clock, enabled):
    a, b = _pair(engine, clock)
    enabled["bob"] = False
    r = engine.ingest("alice", a["device_session"], [Detection(_current_id(b, clock), clock.t, -50)])
    assert r["ignored"] == {"unknown": 1}


# --- confirmation + relationships --------------------------------------------

def test_brief_pass_by_creates_no_relationship(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock), times=(0, 6, 12))
    assert engine.nearby_for("alice") == []
    assert engine.confirm("alice", a["device_session"], _current_id(b, clock))["status"] == "pending"


def test_repeated_sightings_confirm_a_shared_relationship(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    [rel] = engine.nearby_for("alice")
    assert engine.nearby_for("bob") == [rel]           # the relationship belongs to both
    assert rel.proximity == "very_close" and not rel.mutual
    assert rel.expires_at == rel.last_detected + X.RELATIONSHIP_TTL_SECONDS
    status = engine.confirm("alice", a["device_session"], _current_id(b, clock))
    assert status["status"] == "confirmed" and status["nearby_id"] == rel.nearby_id
    assert "bob" not in str(status)


def test_mutual_sighting_marks_relationship_mutual(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    engine.ingest("bob", b["device_session"], [Detection(_current_id(a, clock), clock.t, -60)])
    [rel] = engine.nearby_for("alice")
    assert rel.mutual


def test_relationship_expires_without_sightings(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    clock.t += X.RELATIONSHIP_TTL_SECONDS + 1
    assert engine.nearby_for("alice") == [] and engine.nearby_for("bob") == []
    assert engine.stats()["relationships"] == 0


def test_continued_sightings_extend_relationship(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    [rel] = engine.nearby_for("alice")
    first_expiry = rel.expires_at
    clock.t += 300
    engine.ingest("alice", a["device_session"], [Detection(_current_id(b, clock), clock.t, -62)])
    [rel] = engine.nearby_for("alice")
    assert rel.expires_at > first_expiry


def test_new_encounter_gets_a_new_unlinkable_nearby_id(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    [first] = engine.nearby_for("alice")
    clock.t += X.RELATIONSHIP_TTL_SECONDS + 1
    a = engine.open_session("alice", "ios", a["device_session"])
    b = engine.open_session("bob", "android", b["device_session"])
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    [second] = engine.nearby_for("alice")
    assert second.nearby_id != first.nearby_id


# --- notifications -----------------------------------------------------------

def test_confirmation_notifies_both_people_once(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    [n] = engine.drain_notifications("alice")
    assert n["title"] == "Someone near you is on Squirrel Social 👀"
    assert n["deep_link"] == "squirrelsocial://nearby"
    assert "bob" not in str(n) and "right" not in n["title"].lower()
    assert len(engine.drain_notifications("bob")) == 1
    assert engine.drain_notifications("alice") == []    # drained = acknowledged


def test_same_person_is_not_renotified_within_pair_cooldown(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    engine.drain_notifications("alice")
    clock.t += X.RELATIONSHIP_TTL_SECONDS + USER_NOTIFY_COOLDOWN_SECONDS   # well past user cooldown
    a = engine.open_session("alice", "ios", a["device_session"])
    b = engine.open_session("bob", "android", b["device_session"])
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    assert len(engine.nearby_for("alice")) == 1
    assert engine.drain_notifications("alice") == []
    assert PAIR_NOTIFY_COOLDOWN_SECONDS > X.RELATIONSHIP_TTL_SECONDS + USER_NOTIFY_COOLDOWN_SECONDS


def test_user_cooldown_limits_notifications_across_people(engine, clock):
    a, b = _pair(engine, clock)
    c = engine.open_session("carol", "ios")
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    engine.drain_notifications("alice")
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(c, clock))
    assert len(engine.nearby_for("alice")) == 2
    assert engine.drain_notifications("alice") == []
    [n] = engine.drain_notifications("carol")           # carol has not been notified yet
    assert n["title"] == "Someone near you is on Squirrel Social 👀"


def test_multi_person_copy_once_user_cooldown_lapses(engine, clock):
    """bob stays near alice past her user cooldown; when carol then arrives, alice's notification
    uses the "people around you" copy."""
    a, b = _pair(engine, clock)
    c = engine.open_session("carol", "ios")
    _sit_together(engine, clock, "bob", b["device_session"], _current_id(a, clock))
    assert engine.drain_notifications("alice")[0]["nearby_count"] == 1
    for _ in range(USER_NOTIFY_COOLDOWN_SECONDS // 300 + 1):
        clock.t += 300
        engine.ingest("bob", b["device_session"], [Detection(_current_id(a, clock), clock.t, -60)])
    _sit_together(engine, clock, "carol", c["device_session"], _current_id(a, clock))
    [n] = engine.drain_notifications("alice")
    assert n["nearby_count"] == 2
    assert n["title"] == "Someone nearby is on Squirrel Social 👀"
    assert n["body"] == "There are Squirrel users around you. See who's nearby."


def test_undelivered_notification_goes_stale(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    clock.t += 31 * 60
    assert engine.drain_notifications("alice") == []


# --- opt-out -----------------------------------------------------------------

def test_forget_user_erases_everything_involving_them(engine, clock, enabled):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    enabled["bob"] = False
    engine.forget_user("bob")
    assert engine.nearby_for("alice") == []
    assert engine.drain_notifications("bob") == []
    stats = engine.stats()
    assert stats["pairs"] == 0 and stats["relationships"] == 0 and stats["sessions"] == 1
    with pytest.raises(SessionError):
        engine.ingest("bob", b["device_session"], [])


def test_purge_drops_expired_state(engine, clock):
    a, b = _pair(engine, clock)
    _sit_together(engine, clock, "alice", a["device_session"], _current_id(b, clock))
    clock.t += P.SESSION_TTL_SECONDS + 1
    engine.nearby_for("alice")   # triggers purge
    assert engine.stats() == {"sessions": 0, "ble_ids": 0, "pairs": 0, "relationships": 0}
