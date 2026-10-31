"""Other people's XP is a read cache of the Run Module's total (ADR-032 "XP reads", services/xp_cache.py)."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta

import httpx
from sqlalchemy import update

from app.db import utcnow
from app.models import UserStats
from app.services import run_module as rm
from tests.conftest import auth, new_sub

SVC = {"Authorization": "Bearer svc-secret"}


def _level_in_search(client, viewer: str, username: str, q: str | None = None) -> int:
    items = client.get("/v1/users/search", params={"q": q or username}, headers=auth(viewer)).json()["items"]
    [item] = [i for i in items if i["username"] == username]
    return item["level"]


def _make_stale(database, user_id: str) -> None:
    with database.SessionLocal() as db:
        db.execute(update(UserStats).where(UserStats.user_id == uuid.UUID(user_id))
                   .values(xp_synced_at=utcnow() - timedelta(minutes=6)))
        db.commit()


def test_a_stale_figure_is_refreshed_in_one_call_and_then_served_from_the_cache(api, client, run_module, database):
    viewer, ria, dev = new_sub(), new_sub(), new_sub()
    api.user(viewer)
    ria_id = api.user(ria, username="ria.runs")["id"]
    api.user(dev, username="ria.dev")
    run_module.xp[ria] = 2 * 2000 + 5  # level 3, earned since Social last looked
    run_module.totals_calls.clear()

    assert _level_in_search(client, viewer, "ria.runs", q="ria.") == 3
    assert len(run_module.totals_calls) == 1 and set(run_module.totals_calls[0]) == {ria, dev}  # one call for the list

    # Within the TTL nobody is asked again, even if the Run Module's number moved.
    run_module.xp[ria] = 9 * 2000
    assert _level_in_search(client, viewer, "ria.runs") == 3
    assert client.get(f"/v1/users/{ria_id}/profile", headers=auth(viewer)).json()["stats"]["level"] == 3
    assert len(run_module.totals_calls) == 1

    # Once stale, it is asked for again: the profile shows the new total.
    _make_stale(database, ria_id)
    assert client.get(f"/v1/users/{ria_id}/profile", headers=auth(viewer)).json()["stats"]["xp"] == 9 * 2000
    assert run_module.totals_calls[-1] == [ria]


def test_with_the_run_module_down_the_cached_figure_is_shown(api, client, run_module, database):
    viewer, ria = new_sub(), new_sub()
    api.user(viewer)
    ria_id = api.user(ria, username="ria.runs")["id"]
    run_module.xp[ria] = 4000
    assert _level_in_search(client, viewer, "ria.runs") == 3

    _make_stale(database, ria_id)
    run_module.totals_available = False
    run_module.xp[ria] = 20000
    r = client.get(f"/v1/users/{ria_id}/profile", headers=auth(viewer))
    assert r.status_code == 200 and r.json()["stats"]["xp"] == 4000  # last known, not an error


def test_writes_never_refresh_but_resolve_does(api, client, run_module, database):
    ria = new_sub()
    ria_id = api.user(ria)["id"]
    _make_stale(database, ria_id)
    run_module.xp[ria] = 6000
    run_module.totals_calls.clear()

    # A POST builds summaries mid-request; refreshing there would commit its half-done work.
    me = new_sub()
    api.user(me)
    client.post(f"/v1/users/{ria_id}/follow", headers=auth(me))
    assert run_module.totals_calls == []

    # campus-service's lookup has committed its provisioning first, so it refreshes.
    [p] = client.post("/internal/v1/people/resolve", json={"subjects": [ria]}, headers=SVC).json()["people"]
    assert p["level"] == 4 and run_module.totals_calls == [[ria]]


# --------------------------------------------------------------------------- the HTTP client


def _client(handler) -> rm.HttpRunModule:
    module = rm.HttpRunModule("http://run.test")
    module._client = httpx.Client(base_url="http://run.test", transport=httpx.MockTransport(handler))
    return module


def test_the_client_batches_by_200_sends_only_uuids_and_the_service_token():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/internal/v1/xp/totals" and request.headers["authorization"] == "Bearer svc-secret"
        subjects = json.loads(request.content)["subjects"]
        seen.append(len(subjects))
        return httpx.Response(200, json={s: 7 for s in subjects})

    subs = [new_sub() for _ in range(450)]
    totals = _client(handler).get_xp_totals("svc-secret", subs + ["dev-not-a-uuid", subs[0]])
    assert seen == [200, 200, 50] and len(totals) == 450 and "dev-not-a-uuid" not in totals


def test_the_client_backs_off_after_a_failure():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(401, json={"error": "unauthorized"})

    module = _client(handler)
    assert module.get_xp_totals("svc-secret", [new_sub()]) is None
    assert module.get_xp_totals("svc-secret", [new_sub()]) is None
    assert len(calls) == 1  # the second list didn't wait on it
    assert module.get_xp_totals("", [new_sub()]) is None  # no service token, no call
