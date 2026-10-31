"""Sign-up profile details: age, gender, activities, measurements/BMI, physique, habits, consent.

USERS_DIR is monkeypatched to a temp dir so nothing touches data/users.
"""

from __future__ import annotations

import asyncio
import itertools
import json
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi import FastAPI

from backend import config
from backend.partners import policy as partner_policy
from backend.profiles import service, store
from backend.profiles.router import router as profiles_router
from backend.profiles.vocab import ACTIVITY_CODES, ACTIVITY_TYPES, GENDERS, WORKOUT_TIMES
from backend.tests.storage import corrupt_profile_data, has_profile_data, profiles_in_database, still_corrupt
from backend.users.router import router as users_router
from backend.workouts.catalog import load_catalog

CORE = {
    "first_name": "Ana", "last_name": "Tester", "gender": "female", "height_cm": 165.0,
    "weight_kg": 60.0, "date_of_birth": "1994-05-10", "mobile": "9990001111", "email": "ana@example.test",
}
_emails = itertools.count(1)


def _signup(payload: dict | None = None) -> dict:
    """A sign-up body: CORE plus a password and a fresh email (each account claims its email)."""
    return {**CORE, **(payload or {}), "password": "correct horse", "email": f"ana{next(_emails)}@example.test"}


CONSENT_ALL = [
    {"category": "physique", "granted": True, "policy_version": "2026-09"},
    {"category": "habits", "granted": True, "policy_version": "2026-09"},
]
HABITS = {
    "preferred_workout_times": ["morning", "evening"], "workouts_per_week_goal": 4,
    "avg_sleep_hours": 7.5, "diet": "vegetarian", "smoking": "never", "alcohol": "occasional",
}


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(users_router)
    app.include_router(profiles_router)
    return app


def _request(method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    """Dependency-free ASGI client, same approach as test_sessions."""
    body = json.dumps(payload).encode() if payload is not None else b""
    sent = False
    messages: list[dict] = []

    async def receive() -> dict:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        messages.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
        "root_path": "", "headers": [(b"host", b"test"), (b"content-type", b"application/json")],
        "client": ("127.0.0.1", 12345), "server": ("test", 80),
    }
    asyncio.run(_app()(scope, receive, send))
    start = next(m for m in messages if m["type"] == "http.response.start")
    raw = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return start["status"], json.loads(raw)


def _sign_up(**details) -> str:
    """Page 1 (core fields), then page 2 (the optional questions) when any are given."""
    status, body = _request("POST", "/api/users", _signup())
    assert status == 200, body
    user_id = body["user_id"]
    if details:
        status, body = _request("PUT", f"/api/users/{user_id}/details", details)
        assert status == 200, body
    return user_id


def _details(user_id: str) -> dict:
    status, body = _request("GET", f"/api/users/{user_id}/details")
    assert status == 200, body
    return body


def _user_dirs() -> list[str]:
    return sorted(p.name for p in config.USERS_DIR.iterdir()) if config.USERS_DIR.exists() else []


@pytest.fixture(autouse=True)
def isolated_users(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path)


# ---------------------------------------------------------------- page 1: onboarding

def test_the_existing_onboarding_payload_still_works_and_derives_age_and_bmi():
    uid = _sign_up()
    details = _details(uid)
    born = date(1994, 5, 10)
    assert details["age"] == service.age_on(born, date.today())
    assert details["gender"] == "female"
    assert details["body"]["height_cm"] == 165.0 and details["body"]["weight_kg"] == 60.0
    assert details["body"]["bmi"] == 22.0
    assert details["answered"] == {"fitness": False, "activities": False, "physique": False, "habits": False}
    assert details["physique"] is None and details["habits"] is None
    assert details["consents"] == {"physique": None, "habits": None, "matching": None}


def test_page_one_ignores_page_two_questions():
    status, body = _request("POST", "/api/users", {**_signup(), "habits": {"diet": "vegan"}, "consents": [
        {"category": "habits", "granted": True, "policy_version": "v1"}]})
    assert status == 200
    uid = body["user_id"]
    assert not has_profile_data(uid, store.HABITS_FILENAME) and not has_profile_data(uid, store.CONSENTS_FILENAME)


def test_a_failed_write_during_sign_up_leaves_no_half_created_user(monkeypatch):
    def broken(*_args, **_kwargs):
        raise OSError("disk full")
    monkeypatch.setattr(store, "write_measurements", broken)
    with pytest.raises(OSError):
        service.onboard(dict(CORE))
    assert _user_dirs() == [] and profiles_in_database() == []
    with pytest.raises(OSError):
        service.onboard({**CORE, "email": "rollback@example.test"}, password="correct horse")
    assert _user_dirs() == [] and profiles_in_database() == []


@pytest.mark.parametrize("override", [
    {"gender": "robot"},
    {"date_of_birth": "1990-02-30"},
    {"date_of_birth": "10/05/1994"},
    {"date_of_birth": (date.today() + timedelta(days=1)).isoformat()},
    {"date_of_birth": "1899-12-31"},
    {"height_cm": 10},
    {"weight_kg": 900},
])
def test_page_one_rejects_invalid_answers(override):
    status, _ = _request("POST", "/api/users", _signup(override))
    assert status == 422
    assert _user_dirs() == []


def test_every_gender_the_onboarding_form_offers_is_accepted():
    for gender in ("female", "male", "non_binary", "undisclosed"):
        assert _request("POST", "/api/users", _signup({"gender": gender}))[0] == 200


# ---------------------------------------------------------------- page 2: the optional questions

def test_every_sign_up_question_can_be_answered_in_one_request():
    uid = _sign_up(
        fitness={"fitness_level": "intermediate", "activity_level": "active", "primary_goal": "endurance"},
        activities=[{"activity": "running", "experience": "some", "interest": 5},
                    {"activity": "pushup", "interest": 2}],
        physique={"body_type": "athletic"},
        habits=HABITS,
        consents=CONSENT_ALL,
    )
    details = _details(uid)
    assert details["fitness"] == {"fitness_level": "intermediate", "fitness_level_set": True,
                                  "activity_level": "active", "primary_goal": "endurance"}
    assert details["activities"] == [
        {"activity": "running", "experience": "some", "interest": 5},
        {"activity": "pushup", "experience": None, "interest": 2},
    ]
    assert details["physique"]["body_type"] == "athletic"
    assert details["habits"] == HABITS
    assert details["consents"]["habits"]["granted"] is True
    assert details["consents"]["habits"]["policy_version"] == "2026-09"
    assert all(details["answered"].values())
    # Fitness level is the dashboard's skill level, not a second copy of it.
    assert _request("GET", f"/api/users/{uid}/skill")[1] == {"skill_level": "intermediate", "configured": True}


def _stored_nothing(uid: str) -> bool:
    return not any(has_profile_data(uid, name) for name in (
        store.FITNESS_FILENAME, store.ACTIVITIES_FILENAME, store.PHYSIQUE_FILENAME,
        store.HABITS_FILENAME, store.CONSENTS_FILENAME))


@pytest.mark.parametrize("section,value,consents", [
    ("physique", {"body_type": "average"}, []),
    ("habits", HABITS, []),
    ("habits", HABITS, [{"category": "habits", "granted": False, "policy_version": "v1"}]),
    ("habits", HABITS, [{"category": "physique", "granted": True, "policy_version": "v1"}]),
])
def test_sensitive_sections_need_their_consent_and_a_refused_page_saves_nothing(section, value, consents):
    uid = _sign_up()
    status, body = _request("PUT", f"/api/users/{uid}/details", {
        section: value, "consents": consents, "activities": [{"activity": "yoga"}]})
    assert status == 403 and body["detail"]["code"] == "consent_required"
    assert _stored_nothing(uid)


def test_consent_given_earlier_carries_over_to_a_later_page_two():
    uid = _sign_up(consents=[{"category": "habits", "granted": True, "policy_version": "v1"}])
    assert _request("PUT", f"/api/users/{uid}/details", {"habits": HABITS})[0] == 200
    assert _details(uid)["habits"] == HABITS


def test_withdrawing_consent_on_page_two_erases_and_refuses_that_section():
    uid = _sign_up(habits=HABITS, consents=CONSENT_ALL)
    withdraw = [{"category": "habits", "granted": False, "policy_version": "v1"}]
    status, _ = _request("PUT", f"/api/users/{uid}/details", {"habits": HABITS, "consents": withdraw})
    assert status == 403 and _details(uid)["habits"] == HABITS  # refused request changed nothing
    status, body = _request("PUT", f"/api/users/{uid}/details", {"consents": withdraw})
    assert status == 200 and body["habits"] is None
    assert not has_profile_data(uid, store.HABITS_FILENAME)


def test_page_two_can_be_resubmitted_and_leaves_skipped_sections_alone():
    uid = _sign_up(activities=[{"activity": "yoga"}], fitness={"fitness_level": "advanced"})
    status, body = _request("PUT", f"/api/users/{uid}/details", {"activities": [{"activity": "cycling"}]})
    assert status == 200
    assert [a["activity"] for a in body["activities"]] == ["cycling"]
    assert body["fitness"]["fitness_level"] == "advanced"
    assert _request("PUT", f"/api/users/{uid}/details", {})[0] == 200


def test_an_unreadable_consent_log_refuses_page_two_before_writing_anything():
    uid = _sign_up()
    _corrupt(uid, store.CONSENTS_FILENAME)
    for payload in ({"habits": HABITS, "activities": [{"activity": "yoga"}]},
                    {"consents": CONSENT_ALL, "activities": [{"activity": "yoga"}]}):
        status, body = _request("PUT", f"/api/users/{uid}/details", payload)
        assert status == 503 and body["detail"]["code"] == "consents_unreadable"
    assert not has_profile_data(uid, store.ACTIVITIES_FILENAME)
    # Non-sensitive answers don't need the consent log at all.
    assert _request("PUT", f"/api/users/{uid}/details", {"activities": [{"activity": "yoga"}]})[0] == 200


@pytest.mark.parametrize("payload", [
    {"activities": [{"activity": "yoga"}, {"activity": "yoga"}]},
    {"activities": [{"activity": "parkour"}]},
    {"activities": [{"activity": "yoga", "interest": 9}]},
    {"fitness": {"fitness_level": "wizard"}},
    {"physique": {"body_type": "slim", "bmi": 18}},
    {"consents": [{"category": "habits", "granted": True, "policy_version": "v1"}] * 2},
    {"consents": [{"category": "habits", "granted": True, "policy_version": "has spaces"}]},
    {"height_cm": 170},
])
def test_page_two_rejects_invalid_answers(payload):
    uid = _sign_up()
    assert _request("PUT", f"/api/users/{uid}/details", payload)[0] == 422
    assert _stored_nothing(uid)


def test_page_two_for_an_unknown_user_is_404():
    status, body = _request("PUT", "/api/users/nobody-123456/details", {"activities": []})
    assert status == 404 and body["detail"]["code"] == "user_not_found"
    assert _user_dirs() == []


# ---------------------------------------------------------------- age and BMI

@pytest.mark.parametrize("today,expected", [
    (date(2026, 5, 9), 31),
    (date(2026, 5, 10), 32),
    (date(2026, 12, 31), 32),
])
def test_age_turns_over_on_the_birthday(today, expected):
    assert service.age_on(date(1994, 5, 10), today) == expected


def test_a_leap_day_birthday_ages_on_the_first_of_march():
    assert service.age_on(date(2000, 2, 29), date(2026, 2, 28)) == 25
    assert service.age_on(date(2000, 2, 29), date(2026, 3, 1)) == 26


def test_bmi_pairs_the_latest_height_with_the_latest_weight_even_from_different_readings():
    readings = [
        {"measured_at": "2026-01-01T00:00:00+00:00", "height_cm": 170.0, "weight_kg": 80.0},
        {"measured_at": "2026-03-01T00:00:00+00:00", "weight_kg": 72.0},
        # Logged later but taken earlier: must not beat the March weight.
        {"measured_at": "2026-02-01T00:00:00+00:00", "weight_kg": 99.0},
    ]
    latest = service.latest_values(readings)
    assert latest["height_cm"] == (170.0, "2026-01-01T00:00:00+00:00")
    assert latest["weight_kg"] == (72.0, "2026-03-01T00:00:00+00:00")
    assert service.bmi(170.0, 72.0) == 24.9


def test_same_timestamp_goes_to_the_later_entry():
    at = "2026-01-01T00:00:00+00:00"
    latest = service.latest_values([{"measured_at": at, "weight_kg": 70.0}, {"measured_at": at, "weight_kg": 71.0}])
    assert latest["weight_kg"][0] == 71.0


def test_logging_a_weight_updates_bmi_and_the_dashboard_profile_but_keeps_height():
    uid = _sign_up()
    status, reading = _request("POST", f"/api/users/{uid}/measurements", {"weight_kg": 65.0})
    assert status == 201 and reading["weight_kg"] == 65.0 and "height_cm" not in reading
    assert _details(uid)["body"]["bmi"] == service.bmi(165.0, 65.0)
    profile = _request("GET", f"/api/users/{uid}")[1]
    assert profile["weight_kg"] == 65.0 and profile["height_cm"] == 165.0


def test_users_created_before_measurement_history_keep_their_height_when_logging_weight():
    from backend.users.store import create_user_record
    uid = create_user_record(dict(CORE))["user_id"]  # the old path: no measurements.json
    assert _details(uid)["body"]["bmi"] == 22.0
    _request("POST", f"/api/users/{uid}/measurements", {"weight_kg": 70.0})
    history = _request("GET", f"/api/users/{uid}/measurements")[1]["measurements"]
    assert [r.get("weight_kg") for r in history] == [70.0, 60.0]
    assert _details(uid)["body"]["bmi"] == service.bmi(165.0, 70.0)


def test_measurement_times_are_stored_in_utc_and_future_times_are_refused():
    uid = _sign_up()
    status, reading = _request("POST", f"/api/users/{uid}/measurements",
                               {"weight_kg": 61.0, "measured_at": "2026-01-01T10:00:00+05:30"})
    assert status == 201 and reading["measured_at"] == "2026-01-01T04:30:00+00:00"
    status, reading = _request("POST", f"/api/users/{uid}/measurements",
                               {"weight_kg": 61.0, "measured_at": "2026-01-01T10:00:00"})
    assert status == 201 and reading["measured_at"] == "2026-01-01T10:00:00+00:00"
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    assert _request("POST", f"/api/users/{uid}/measurements", {"weight_kg": 61.0, "measured_at": future})[0] == 422


def test_an_empty_measurement_is_refused():
    uid = _sign_up()
    assert _request("POST", f"/api/users/{uid}/measurements", {"source": "wearable"})[0] == 422


# ---------------------------------------------------------------- consent

def _grant(uid: str, category: str, granted: bool = True) -> tuple[int, dict]:
    return _request("POST", f"/api/users/{uid}/consents",
                    {"category": category, "granted": granted, "policy_version": "2026-09"})


def test_physique_needs_consent_after_sign_up_too():
    uid = _sign_up()
    status, body = _request("PUT", f"/api/users/{uid}/details/physique", {"body_type": "slim"})
    assert status == 403 and body["detail"]["code"] == "consent_required"
    status, body = _request("POST", f"/api/users/{uid}/measurements", {"body_fat_pct": 20.0})
    assert status == 403
    assert _grant(uid, "physique")[0] == 200
    assert _request("PUT", f"/api/users/{uid}/details/physique", {"body_type": "slim"})[0] == 200
    assert _request("POST", f"/api/users/{uid}/measurements", {"body_fat_pct": 20.0, "waist_cm": 74})[0] == 201
    physique = _details(uid)["physique"]
    assert physique["body_type"] == "slim" and physique["body_fat_pct"] == 20.0 and physique["waist_cm"] == 74.0


def test_withdrawing_physique_consent_erases_body_type_and_body_composition_but_not_weight():
    uid = _sign_up(physique={"body_type": "muscular"}, habits=HABITS, consents=CONSENT_ALL)
    _request("POST", f"/api/users/{uid}/measurements", {"body_fat_pct": 18.0})
    _request("POST", f"/api/users/{uid}/measurements", {"weight_kg": 62.0, "waist_cm": 70.0})

    status, body = _grant(uid, "physique", granted=False)
    assert status == 200 and body["consents"]["physique"]["granted"] is False

    assert not has_profile_data(uid, store.PHYSIQUE_FILENAME)
    raw = store.read_measurements(uid)
    assert all("body_fat_pct" not in r and "waist_cm" not in r for r in raw)
    assert [r.get("weight_kg") for r in raw] == [60.0, 62.0]  # the body-fat-only reading is gone
    details = _details(uid)
    assert details["physique"] is None and details["body"]["weight_kg"] == 62.0
    # Habits are a separate category and are untouched.
    assert details["habits"] == HABITS


def test_withdrawing_habits_consent_erases_habits():
    uid = _sign_up(habits=HABITS, consents=CONSENT_ALL)
    _grant(uid, "habits", granted=False)
    assert not has_profile_data(uid, store.HABITS_FILENAME)
    assert _details(uid)["habits"] is None
    assert _request("PUT", f"/api/users/{uid}/details/habits", HABITS)[0] == 403


def test_consent_history_is_kept_and_the_latest_decision_wins():
    uid = _sign_up()
    _grant(uid, "habits")
    _grant(uid, "habits", granted=False)
    _grant(uid, "habits")
    events = store.read_consent_events(uid)
    assert [e["granted"] for e in events] == [True, False, True]
    assert _request("GET", f"/api/users/{uid}/consents")[1]["consents"]["habits"]["granted"] is True


def test_physique_readings_without_consent_are_never_shown():
    uid = _sign_up()
    # e.g. data written before a withdrawal could be erased
    store.write_measurements(uid, store.read_measurements(uid) + [
        {"id": "x", "measured_at": "2026-01-01T00:00:00+00:00", "source": "self_reported", "body_fat_pct": 30.0}])
    history = _request("GET", f"/api/users/{uid}/measurements")[1]["measurements"]
    assert all("body_fat_pct" not in r for r in history) and len(history) == 1
    assert _details(uid)["physique"] is None


# ---------------------------------------------------------------- unreadable files fail closed

def _corrupt(uid: str, filename: str) -> None:
    corrupt_profile_data(uid, filename)


def test_an_unreadable_consent_log_hides_sensitive_data_and_is_never_overwritten():
    uid = _sign_up(habits=HABITS, consents=CONSENT_ALL)
    _corrupt(uid, store.CONSENTS_FILENAME)

    details = _details(uid)
    assert details["habits"] is None and details["consents_readable"] is False
    status, body = _request("PUT", f"/api/users/{uid}/details/habits", HABITS)
    assert status == 503 and body["detail"]["code"] == "consents_unreadable"
    assert _grant(uid, "habits")[0] == 503
    assert still_corrupt(uid, store.CONSENTS_FILENAME)
    assert _request("GET", f"/api/users/{uid}/consents")[0] == 503


def test_an_unreadable_measurement_history_is_never_overwritten():
    uid = _sign_up()
    _corrupt(uid, store.MEASUREMENTS_FILENAME)
    status, body = _request("POST", f"/api/users/{uid}/measurements", {"weight_kg": 61.0})
    assert status == 500 and body["detail"]["code"] == "measurements_unreadable"
    assert still_corrupt(uid, store.MEASUREMENTS_FILENAME)
    # The dashboard falls back to the onboarding values instead of failing.
    assert _request("GET", f"/api/users/{uid}")[1]["weight_kg"] == 60.0
    assert _details(uid)["body"]["bmi"] is None


def test_withdrawal_is_recorded_even_when_measurements_cannot_be_erased():
    uid = _sign_up(physique={"body_type": "slim"}, consents=CONSENT_ALL)
    _corrupt(uid, store.MEASUREMENTS_FILENAME)
    status, body = _grant(uid, "physique", granted=False)
    assert status == 500 and body["detail"]["code"] == "erasure_incomplete"
    assert service.consent_state(store.read_consent_events(uid))["physique"]["granted"] is False
    assert not has_profile_data(uid, store.PHYSIQUE_FILENAME)
    assert _details(uid)["physique"] is None


def test_a_corrupt_section_reads_as_unanswered():
    uid = _sign_up(activities=[{"activity": "yoga"}])
    _corrupt(uid, store.ACTIVITIES_FILENAME)
    details = _details(uid)
    assert details["activities"] == [] and details["answered"]["activities"] is False


# ---------------------------------------------------------------- sections after sign-up

def test_sections_can_be_answered_and_replaced_after_sign_up():
    uid = _sign_up()
    status, fitness = _request("PUT", f"/api/users/{uid}/details/fitness",
                               {"fitness_level": "advanced", "primary_goal": "build_muscle"})
    assert status == 200 and fitness["fitness_level"] == "advanced" and fitness["activity_level"] is None
    _request("PUT", f"/api/users/{uid}/details/activities", {"activities": [{"activity": "yoga"}]})
    status, body = _request("PUT", f"/api/users/{uid}/details/activities",
                            {"activities": [{"activity": "cycling", "interest": 4}]})
    assert status == 200
    assert _details(uid)["activities"] == [{"activity": "cycling", "experience": None, "interest": 4}]
    # An empty list is an answer ("none"), distinct from never answering.
    _request("PUT", f"/api/users/{uid}/details/activities", {"activities": []})
    assert _details(uid)["answered"]["activities"] is True


def test_unknown_fields_are_rejected():
    uid = _sign_up()
    assert _request("PUT", f"/api/users/{uid}/details/habits", {**HABITS, "weight": 3})[0] == 422
    assert _request("PUT", f"/api/users/{uid}/details/fitness", {"fitness_level": "beginner", "bmi": 20})[0] == 422


def test_user_ids_are_checked():
    assert _request("GET", "/api/users/..%2Fetc/details")[0] in (400, 404)
    assert _request("GET", "/api/users/Bad_ID/details")[0] == 400
    status, body = _request("GET", "/api/users/nobody-123456/details")
    assert status == 404 and body["detail"]["code"] == "user_not_found"
    assert _request("PUT", "/api/users/nobody-123456/details/activities", {"activities": []})[0] == 404
    assert _request("POST", "/api/users/nobody-123456/consents",
                    {"category": "habits", "granted": True, "policy_version": "v1"})[0] == 404
    assert _user_dirs() == []


# ---------------------------------------------------------------- catalogue consistency

def test_activity_catalogue_is_served():
    status, body = _request("GET", "/api/activity-types")
    assert status == 200 and [a["code"] for a in body["activity_types"]] == list(ACTIVITY_CODES)


def test_every_enabled_exercise_is_a_tracked_activity():
    tracked = {a.code for a in ACTIVITY_TYPES if a.tracked_by == "exercise_module"}
    assert {e.slug for e in load_catalog().enabled()} <= tracked


def test_vocabularies_agree_with_partner_hunt():
    assert set(partner_policy.ACTIVITIES) <= set(ACTIVITY_CODES)
    assert partner_policy.WORKOUT_TIMES == WORKOUT_TIMES
    assert set(partner_policy.PARTNER_GENDERS) <= set(GENDERS)
    assert len(set(ACTIVITY_CODES)) == len(ACTIVITY_CODES)
