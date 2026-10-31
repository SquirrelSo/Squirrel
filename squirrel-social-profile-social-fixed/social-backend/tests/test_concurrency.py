"""Counters under concurrent writes. PostgreSQL only: SQLite serialises writers, so the race
this guards against can't happen there."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from tests.conftest import auth, new_sub


@pytest.fixture
def pg(database):
    if database.engine.dialect.name != "postgresql":
        pytest.skip("set SOCIAL_TEST_DATABASE_URL to a PostgreSQL database")


def test_concurrent_likes_and_follows_keep_counts_exact(pg, api, client):
    author = new_sub()
    author_id = api.user(author)["id"]
    pid = api.post(author)["id"]
    fans = [new_sub() for _ in range(12)]
    for f in fans:
        api.me(f)

    def hammer(sub):
        c = TestClient(client.app)
        for _ in range(3):  # every fan double/triple-taps both buttons at once
            c.post(f"/v1/posts/{pid}/like", headers=auth(sub))
            c.post(f"/v1/users/{author_id}/follow", headers=auth(sub))

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(hammer, fans))

    assert client.get(f"/v1/posts/{pid}", headers=auth(author)).json()["likes_count"] == 12
    assert api.me(author)["stats"]["followers"] == 12
    assert all(api.me(f)["stats"]["following"] == 1 for f in fans)

    def unhammer(sub):
        c = TestClient(client.app)
        for _ in range(3):
            c.delete(f"/v1/posts/{pid}/like", headers=auth(sub))
            c.delete(f"/v1/users/{author_id}/follow", headers=auth(sub))

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(unhammer, fans[:5]))

    assert client.get(f"/v1/posts/{pid}", headers=auth(author)).json()["likes_count"] == 7
    assert api.me(author)["stats"]["followers"] == 7
