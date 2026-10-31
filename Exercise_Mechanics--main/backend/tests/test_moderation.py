"""Reports: members flag members or sessions; moderators review them behind a token."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI

from backend import config
from backend.moderation import policy, service, store
from backend.moderation.router import router as moderation_router
from backend.sessions.store import create_session_record
from backend.users.store import create_user_record

TOKEN = "test-moderator-token"
AUTH = {"authorization": f"Bearer {TOKEN}"}


def _request(method: str, path: str, payload: dict | None = None, *, headers: dict | None = None,
             query: dict | None = None) -> tuple[int, dict]:
    app = FastAPI()
    app.include_router(moderation_router)
    body = json.dumps(payload).encode() if payload is not None else b""
    sent, messages = False, []

    async def receive() -> dict:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        messages.append(message)

    raw_headers = [(b"host", b"test"), (b"content-type", b"application/json")]
    raw_headers += [(k.encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
        "query_string": urlencode(query or {}).encode(), "root_path": "", "headers": raw_headers,
        "client": ("127.0.0.1", 12345), "server": ("test", 80),
    }
    asyncio.run(app(scope, receive, send))
    start = next(m for m in messages if m["type"] == "http.response.start")
    raw = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return start["status"], json.loads(raw)


def member(first: str) -> str:
    return create_user_record({
        "first_name": first, "last_name": "Tester", "gender": "female", "height_cm": 170.0, "weight_kg": 65.0,
        "date_of_birth": "1994-05-10", "mobile": "9990001111", "email": f"{first.lower()}@example.test",
    })["user_id"]


def report(reporter: str, target: str, category: str = "harassment", **extra) -> tuple[int, dict]:
    return _request("POST", f"/api/users/{reporter}/reports",
                    {"reported_user_id": target, "category": category, **extra})


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path / "users")
    monkeypatch.setattr(config, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setenv("MODERATION_TOKEN", TOKEN)


# ---------------------------------------------------------------- filing a report

def test_a_report_records_who_whom_what_when_and_status():
    ana, ben = member("Ana"), member("Ben")
    status, body = report(ana, ben, "harassment", description="Rude messages after a run", source="partner_hunt")
    assert status == 201 and body["already_reported"] is False
    filed = body["report"]
    assert filed["target"] == {"type": "user", "user_id": ben}
    assert filed["category"] == "harassment" and filed["status"] == "open"
    assert filed["description"] == "Rude messages after a run" and filed["source"] == "partner_hunt"
    stored = store.read_report(filed["report_id"])
    assert stored["reporter_id"] == ana and stored["created_at"] == filed["created_at"]
    assert stored["history"][0]["status"] == "open"


@pytest.mark.parametrize("category", list(policy.CATEGORIES))
def test_every_category_can_be_reported(category):
    ana, ben = member("Ana"), member("Ben")
    extra = {"description": "Something else happened"} if category == "other" else {}
    assert report(ana, ben, category, **extra)[0] == 201


def test_a_session_can_be_reported_for_manipulated_workout_data():
    ana, ben = member("Ana"), member("Ben")
    sid = create_session_record(ben, {"exercise_id": "squat", "sets": 1}, "beginner")["session_id"]
    status, body = report(ana, ben, "cheating", session_id=sid, description="500 reps in 2 minutes")
    assert status == 201
    assert body["report"]["target"] == {"type": "session", "user_id": ben, "session_id": sid}


def test_a_session_must_belong_to_the_reported_member():
    ana, ben, cat = member("Ana"), member("Ben"), member("Cat")
    sid = create_session_record(cat, {"exercise_id": "squat", "sets": 1}, "beginner")["session_id"]
    status, body = report(ana, ben, "cheating", session_id=sid)
    assert status == 404 and body["detail"]["code"] == "session_not_found"


def test_reporting_the_same_thing_twice_while_under_review_does_not_duplicate():
    ana, ben = member("Ana"), member("Ben")
    first = report(ana, ben, "spam")[1]["report"]
    status, body = report(ana, ben, "spam")
    assert status == 200 and body["already_reported"] is True and body["report"]["report_id"] == first["report_id"]
    assert report(ana, ben, "harassment")[0] == 201  # a different problem is a new report
    service.update_status(first["report_id"], "resolved", "Warned")
    assert report(ana, ben, "spam")[0] == 201  # once closed, it can be reported again


def test_members_are_limited_to_a_number_of_reports_a_day():
    ana = member("Ana")
    targets = [member(f"T{i}") for i in range(policy.DAILY_LIMIT + 1)]
    for target in targets[:-1]:
        assert report(ana, target)[0] == 201
    status, body = report(ana, targets[-1])
    assert status == 429 and body["detail"]["code"] == "report_limit"
    later = datetime.now(timezone.utc) + timedelta(hours=25)
    assert service.file_report(ana, {"reported_user_id": targets[-1], "category": "spam"}, now=later)[1] is True


@pytest.mark.parametrize("payload,expected", [
    ({"category": "harassment"}, 422),                                   # no target
    ({"reported_user_id": "{target}", "category": "rudeness"}, 422),     # unknown category
    ({"reported_user_id": "{target}", "category": "other"}, 422),        # "other" needs a description
    ({"reported_user_id": "{target}", "category": "spam", "description": "x" * 1001}, 422),
    ({"reported_user_id": "Bad_ID", "category": "spam"}, 422),
    ({"reported_user_id": "{target}", "category": "spam", "severity": "high"}, 422),
    ({"reported_user_id": "nobody-123456", "category": "spam"}, 404),
    ({"reported_user_id": "{self}", "category": "spam"}, 400),
])
def test_invalid_reports_are_refused_and_nothing_is_stored(payload, expected):
    ana, ben = member("Ana"), member("Ben")
    body = {k: (v.replace("{target}", ben).replace("{self}", ana) if isinstance(v, str) else v) for k, v in payload.items()}
    assert _request("POST", f"/api/users/{ana}/reports", body)[0] == expected
    assert store.all_reports() == ([], [])


def test_members_see_their_own_reports_but_not_moderator_notes_or_reports_against_them():
    ana, ben = member("Ana"), member("Ben")
    filed = report(ana, ben, "spam")[1]["report"]
    service.update_status(filed["report_id"], "resolved", "Account suspended for 7 days")
    [mine] = _request("GET", f"/api/users/{ana}/reports")[1]["reports"]
    assert mine["status"] == "resolved"
    assert "resolution_note" not in mine and "history" not in mine and "reporter_id" not in mine
    assert _request("GET", f"/api/users/{ben}/reports")[1]["reports"] == []  # Ben never sees who reported him


# ---------------------------------------------------------------- moderation

def test_moderators_review_the_queue_and_every_change_is_kept():
    ana, ben, cat = member("Ana"), member("Ben"), member("Cat")
    first = report(ana, ben, "harassment")[1]["report"]["report_id"]
    report(cat, ben, "fake_profile")
    report(ana, cat, "spam")

    status, queue = _request("GET", "/api/moderation/reports", headers=AUTH, query={"reported_user_id": ben})
    assert status == 200 and len(queue["reports"]) == 2
    assert all(r["reports_against_member"] == 2 for r in queue["reports"])
    assert queue["reports"][0]["reporter_id"] in (ana, cat)

    _request("PATCH", f"/api/moderation/reports/{first}", {"status": "in_review"}, headers=AUTH)
    status, body = _request("PATCH", f"/api/moderation/reports/{first}",
                            {"status": "resolved", "note": "Warning sent"}, headers=AUTH)
    assert status == 200 and body["report"]["resolution_note"] == "Warning sent"
    assert [h["status"] for h in body["report"]["history"]] == ["open", "in_review", "resolved"]
    open_only = _request("GET", "/api/moderation/reports", headers=AUTH, query={"status": "open"})[1]["reports"]
    assert first not in [r["report_id"] for r in open_only] and len(open_only) == 2


def test_setting_the_same_status_again_is_refused():
    ana, ben = member("Ana"), member("Ben")
    rid = report(ana, ben)[1]["report"]["report_id"]
    assert _request("PATCH", f"/api/moderation/reports/{rid}", {"status": "open"}, headers=AUTH)[0] == 409


@pytest.mark.parametrize("headers", [None, {"authorization": "Bearer wrong"}, {"authorization": TOKEN + "x"}])
def test_moderator_routes_need_the_token(headers):
    ana, ben = member("Ana"), member("Ben")
    rid = report(ana, ben)[1]["report"]["report_id"]
    assert _request("GET", "/api/moderation/reports", headers=headers)[0] == 401
    assert _request("GET", f"/api/moderation/reports/{rid}", headers=headers)[0] == 401
    assert _request("PATCH", f"/api/moderation/reports/{rid}", {"status": "dismissed"}, headers=headers)[0] == 401
    assert store.read_report(rid)["status"] == "open"


def test_without_a_configured_token_moderation_is_closed(monkeypatch):
    monkeypatch.delenv("MODERATION_TOKEN")
    status, body = _request("GET", "/api/moderation/reports", headers=AUTH)
    assert status == 503 and body["detail"]["code"] == "moderation_not_configured"


def test_unreadable_reports_are_shown_to_moderators_not_dropped():
    ana, ben = member("Ana"), member("Ben")
    rid = report(ana, ben)[1]["report"]["report_id"]
    (config.REPORTS_DIR / f"{rid}.json").write_text("{broken")
    queue = _request("GET", "/api/moderation/reports", headers=AUTH)[1]
    assert queue["reports"] == [] and queue["unreadable"] == [rid]
    assert _request("GET", f"/api/moderation/reports/{rid}", headers=AUTH)[0] == 500


def test_unknown_or_malformed_report_ids_are_404():
    assert _request("GET", "/api/moderation/reports/rpt_20260101T000000_0000000000", headers=AUTH)[0] == 404
    assert _request("GET", "/api/moderation/reports/..%2F..%2Fetc", headers=AUTH)[0] == 404
