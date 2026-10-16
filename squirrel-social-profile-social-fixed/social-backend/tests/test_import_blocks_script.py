"""scripts/import_blocks.py: reads Partner Hunt block files and sends them through the real import route."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from tests.conftest import new_sub

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import import_blocks  # noqa: E402

SVC = {"Authorization": "Bearer svc-secret"}


def _write(users: Path, owner: str, payload) -> None:
    (users / owner).mkdir(parents=True)
    (users / owner / "partner_blocks.json").write_text(payload if isinstance(payload, str) else json.dumps(payload))


def test_partner_hunt_files_reach_social(client, tmp_path):
    a, b, c = new_sub(), new_sub(), new_sub()
    _write(tmp_path, a, {"blocked": [b, c]})
    _write(tmp_path, b, {"blocked": [a]})
    _write(tmp_path, c, "{not json")
    (tmp_path / a / "partner_hunt.json").write_text("{}")  # other files are ignored

    pairs, unreadable = import_blocks.partner_hunt_pairs(tmp_path)
    assert sorted(pairs) == sorted([(a, b), (a, c), (b, a)])
    assert len(unreadable) == 1 and c in unreadable[0]

    def send(batch):
        r = client.post("/internal/v1/blocks/import", headers=SVC,
                        json={"blocks": [{"blocker": x, "blocked": y} for x, y in batch]})
        assert r.status_code == 200, r.text
        return r.json()

    pairs = import_blocks.unique(pairs + [(a, b)])
    assert import_blocks.run(pairs, send, out=lambda *_: None) == {"imported": 3, "already": 0, "skipped": 0}
    assert import_blocks.run(pairs, send, out=lambda *_: None) == {"imported": 0, "already": 3, "skipped": 0}
    blocked = client.get(f"/internal/v1/blocks/{a}", headers=SVC).json()["blocked"]
    assert sorted(blocked) == sorted([b, c])


def test_batches(monkeypatch):
    monkeypatch.setattr(import_blocks, "BATCH", 2)
    sizes = []
    totals = import_blocks.run([(str(i), "x") for i in range(5)],
                               lambda batch: sizes.append(len(batch)) or {"imported": len(batch)}, out=lambda *_: None)
    assert sizes == [2, 2, 1] and totals["imported"] == 5


def test_dry_run_sends_nothing_and_apply_needs_the_token(tmp_path, monkeypatch, capsys):
    _write(tmp_path, "u1", {"blocked": ["u2"]})
    monkeypatch.setattr(import_blocks, "http_sender", lambda *a, **k: (_ for _ in ()).throw(AssertionError("sent")))
    assert import_blocks.main(["--social-url", "http://x", "--partner-hunt-dir", str(tmp_path)]) == 0
    assert "dry run" in capsys.readouterr().out
    monkeypatch.delenv("SOCIAL_INTERNAL_TOKEN", raising=False)
    assert import_blocks.main(["--social-url", "http://x", "--partner-hunt-dir", str(tmp_path), "--apply"]) == 2
