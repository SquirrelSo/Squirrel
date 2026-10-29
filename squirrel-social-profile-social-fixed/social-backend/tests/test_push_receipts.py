"""Expo push receipts: ticket ids are stored on send, receipts fetched once they are 15 minutes old,
failures logged with their reason, dead tokens disabled, and the rows cleaned up."""

from __future__ import annotations

import json
import logging
from datetime import timedelta

import httpx
from sqlalchemy import select, update

from app.db import utcnow
from app.models import PushTicket, PushToken
from app.services.push import EXPO_RECEIPTS_URL, ExpoPush
from tests.conftest import auth, new_sub

SVC = {"Authorization": "Bearer svc-secret"}
DEAD, LIVE, BIG = "ExponentPushToken[dead]", "ExponentPushToken[live]", "ExponentPushToken[big]"


def _tokens(client, api):
    me = new_sub()
    api.user(me)
    for t in (DEAD, LIVE, BIG):
        client.post("/v1/me/push-tokens", json={"token": t, "platform": "ios"}, headers=auth(me))


class FakeExpo:
    def __init__(self):
        self.receipt_requests: list[list[str]] = []
        self.receipts: dict = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if str(request.url) == EXPO_RECEIPTS_URL:
            ids = json.loads(request.read())["ids"]
            self.receipt_requests.append(ids)
            return httpx.Response(200, json={"data": {i: r for i, r in self.receipts.items() if i in ids}})
        sent = json.loads(request.read())
        return httpx.Response(200, json={"data": [{"status": "ok", "id": f"ticket-{m['to']}"} for m in sent]})


def _age(database, minutes):
    with database.SessionLocal() as db:
        db.execute(update(PushTicket).values(created_at=utcnow() - timedelta(minutes=minutes)))
        db.commit()


def _state(database):
    with database.SessionLocal() as db:
        tokens = dict(db.execute(select(PushToken.token, PushToken.disabled_at)).all())
        tickets = set(db.scalars(select(PushTicket.id)).all())
    return tokens, tickets


def test_receipts_are_read_after_15_minutes_failures_logged_and_dead_tokens_disabled(client, api, database, caplog):
    _tokens(client, api)
    expo = FakeExpo()
    sender = ExpoPush(database, client=httpx.Client(transport=httpx.MockTransport(expo)))
    sender.deliver([{"to": t, "title": "t"} for t in (DEAD, LIVE, BIG)])
    _, tickets = _state(database)
    assert tickets == {f"ticket-{t}" for t in (DEAD, LIVE, BIG)}

    assert sender.check_receipts() == 0 and expo.receipt_requests == []  # too early to ask

    _age(database, 16)
    expo.receipts = {
        f"ticket-{DEAD}": {"status": "error", "message": "not registered", "details": {"error": "DeviceNotRegistered"}},
        f"ticket-{BIG}": {"status": "error", "message": "payload too big", "details": {"error": "MessageTooBig"}},
        # LIVE's receipt isn't ready yet
    }
    with caplog.at_level(logging.WARNING, logger="app.services.push"):
        assert sender.check_receipts() == 2
    tokens, tickets = _state(database)
    assert tokens[DEAD] is not None and tokens[LIVE] is None and tokens[BIG] is None
    assert tickets == {f"ticket-{LIVE}"}  # asked again next run
    assert "DeviceNotRegistered" in caplog.text and "MessageTooBig" in caplog.text and "payload too big" in caplog.text
    assert LIVE not in caplog.text  # only failures are logged

    expo.receipts = {f"ticket-{LIVE}": {"status": "ok"}}
    assert sender.check_receipts() == 1
    assert _state(database)[1] == set()


def test_a_receipt_that_never_comes_is_dropped_after_a_day(client, api, database):
    _tokens(client, api)
    expo = FakeExpo()
    sender = ExpoPush(database, client=httpx.Client(transport=httpx.MockTransport(expo)))
    sender.deliver([{"to": LIVE, "title": "t"}])
    _age(database, 25 * 60)
    assert sender.check_receipts() == 0 and expo.receipt_requests == []
    assert _state(database)[1] == set()


def test_expo_unreachable_keeps_the_tickets_for_the_next_run(client, api, database):
    _tokens(client, api)
    sender = ExpoPush(database, client=httpx.Client(transport=httpx.MockTransport(FakeExpo())))
    sender.deliver([{"to": LIVE, "title": "t"}])
    _age(database, 20)

    def down(request):
        raise httpx.ConnectError("down")

    broken = ExpoPush(database, client=httpx.Client(transport=httpx.MockTransport(down)))
    assert broken.check_receipts() == 0
    assert _state(database)[1] == {f"ticket-{LIVE}"}


def test_the_cron_endpoint_runs_the_check(client):
    assert client.post("/internal/v1/tasks/push-receipts").status_code == 401
    # The test app records pushes instead of sending them, so there is nothing to check.
    assert client.post("/internal/v1/tasks/push-receipts", headers=SVC).json() == {"receipts_read": 0}
