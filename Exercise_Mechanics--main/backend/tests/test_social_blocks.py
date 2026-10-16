"""The Social block client (backend/social_blocks.py): what it sends, and that it fails closed.

The board-level behaviour (hidden pairs, withheld boards, the 30-second cache) is tested through
the routes in test_partner_hunt.py and test_activity_matching.py.
"""

from __future__ import annotations

import io
import json

import pytest

from backend import social_blocks
from backend.tests.fake_social import TOKEN, URL


def test_a_lookup_asks_for_one_person_with_the_service_token(fake_social, monkeypatch):
    sent = []

    def opener(request, timeout):
        sent.append((request, timeout))
        return fake_social(request, timeout)

    monkeypatch.setattr(social_blocks, "_urlopen", opener)
    monkeypatch.setenv("SOCIAL_API_URL", URL + "/")
    fake_social.block("ana s/1", "ben")
    fake_social.block("cat", "ana s/1")
    assert social_blocks.blocked_either_way("ana s/1") == {"ben", "cat"}
    request, timeout = sent[0]
    assert request.get_method() == "GET" and timeout == social_blocks.TIMEOUT_S
    assert request.full_url == f"{URL}/internal/v1/blocks/ana%20s%2F1"
    assert request.get_header("Authorization") == f"Bearer {TOKEN}"


def test_a_block_is_sent_to_the_import_route_and_repeats_safely(fake_social):
    social_blocks.block("ana", "ben")
    social_blocks.block("ana", "ben")
    assert fake_social.pairs == {("ana", "ben")}
    assert [r for r in fake_social.requests if r[0] == "POST"] == [
        ("POST", "/internal/v1/blocks/import", {"blocks": [{"blocker": "ana", "blocked": "ben"}]})] * 2


@pytest.mark.parametrize("answer", [
    {"subject": "someone-else", "blocked": []},     # not the person asked about
    {"subject": "ana", "blocked": None},
    {"subject": "ana", "blocked": ["ben", 7]},
    ["ben"],
])
def test_an_answer_in_the_wrong_shape_is_no_answer(fake_social, monkeypatch, answer):
    monkeypatch.setattr(social_blocks, "_urlopen", lambda request, timeout: io.BytesIO(json.dumps(answer).encode()))
    with pytest.raises(social_blocks.BlocksUnreachable):
        social_blocks.blocked_either_way("ana")


def test_a_block_social_did_not_confirm_is_refused(fake_social, monkeypatch):
    monkeypatch.setattr(social_blocks, "_urlopen", lambda request, timeout: io.BytesIO(b'{"skipped": 1}'))
    with pytest.raises(social_blocks.BlocksUnreachable):
        social_blocks.block("ana", "ben")


def test_a_failed_lookup_is_never_cached(fake_social):
    fake_social.failure = 404
    with pytest.raises(social_blocks.BlocksUnreachable):
        social_blocks.blocked_either_way("ana")
    fake_social.failure = None
    fake_social.block("ana", "ben")
    assert social_blocks.blocked_either_way("ana") == {"ben"}
    assert fake_social.lookups() == ["ana", "ana"]
