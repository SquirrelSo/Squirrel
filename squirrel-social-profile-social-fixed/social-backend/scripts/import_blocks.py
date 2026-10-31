"""One-time copy of blocks kept outside Social into Social (ADR-032), before those tables are dropped.

Sources (either or both):
  --campus-db URL         campus-service's Postgres: every row of its `blocks` table
  --partner-hunt-dir DIR  a copy of the Exercise backend's data/users/ folder: every
                          <user id>/partner_blocks.json ({"blocked": [user id, ...]})

Both already key people by login `sub`, which is what Social's import takes.

    export SOCIAL_INTERNAL_TOKEN=...      # never on the command line (shell history)
    python scripts/import_blocks.py --social-url https://<social> --campus-db "$CAMPUS_DATABASE_URL"
    python scripts/import_blocks.py ... --apply

Without --apply it only reads the sources and prints what it would send. With --apply it POSTs
to /internal/v1/blocks/import in batches. Social counts pairs it already has instead of
duplicating them, so re-running after a failure (or twice) is safe.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable
from pathlib import Path

BATCH = 500  # the route takes up to 1000
Pair = tuple[str, str]  # (blocker, blocked)


def campus_pairs(database_url: str) -> list[Pair]:
    import psycopg  # only needed for this source

    with psycopg.connect(database_url) as conn:
        rows = conn.execute("SELECT blocker_id, blocked_id FROM blocks ORDER BY created_at").fetchall()
    return [(str(a), str(b)) for a, b in rows]


def partner_hunt_pairs(users_dir: Path) -> tuple[list[Pair], list[str]]:
    """Pairs from every readable partner_blocks.json, plus the files that couldn't be read."""
    if not users_dir.is_dir():
        raise SystemExit(f"{users_dir} is not a directory")
    pairs: list[Pair] = []
    unreadable: list[str] = []
    for path in sorted(users_dir.glob("*/partner_blocks.json")):
        try:
            blocked = json.loads(path.read_text(encoding="utf-8"))["blocked"]
            if not isinstance(blocked, list) or not all(isinstance(b, str) for b in blocked):
                raise ValueError("'blocked' is not a list of ids")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            unreadable.append(f"{path}: {exc}")
            continue
        pairs.extend((path.parent.name, b) for b in blocked)
    return pairs, unreadable


def unique(pairs: Iterable[Pair]) -> list[Pair]:
    return list(dict.fromkeys(pairs))


def http_sender(social_url: str, token: str, timeout_s: float = 30) -> Callable[[list[Pair]], dict]:
    url = social_url.rstrip("/") + "/internal/v1/blocks/import"

    def send(batch: list[Pair]) -> dict:
        body = json.dumps({"blocks": [{"blocker": a, "blocked": b} for a, b in batch]}).encode()
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:500].decode(errors="replace")
            hint = " (404: Social without this route, or SOCIAL_INTERNAL_TOKEN unset on Social)" if exc.code == 404 else ""
            raise SystemExit(f"Social answered {exc.code}{hint}: {detail}") from None

    return send


def run(pairs: list[Pair], send: Callable[[list[Pair]], dict], out=print) -> dict:
    totals = {"imported": 0, "already": 0, "skipped": 0}
    for i in range(0, len(pairs), BATCH):
        batch = pairs[i:i + BATCH]
        result = send(batch)
        for k in totals:
            totals[k] += int(result.get(k, 0))
        out(f"  batch {i // BATCH + 1}: {len(batch)} pairs → {result}")
    return totals


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--social-url", required=True, help="Social's base URL")
    p.add_argument("--campus-db", help="campus-service Postgres URL (read only)")
    p.add_argument("--partner-hunt-dir", type=Path, help="copy of the Exercise backend's data/users/")
    p.add_argument("--apply", action="store_true", help="send to Social (default: dry run)")
    args = p.parse_args(argv)
    if not args.campus_db and not args.partner_hunt_dir:
        p.error("give --campus-db and/or --partner-hunt-dir")

    pairs: list[Pair] = []
    if args.campus_db:
        found = campus_pairs(args.campus_db)
        print(f"campus-service blocks: {len(found)}")
        pairs += found
    if args.partner_hunt_dir:
        found, unreadable = partner_hunt_pairs(args.partner_hunt_dir)
        print(f"Partner Hunt blocks: {len(found)}")
        for line in unreadable:
            print(f"  UNREADABLE, not imported: {line}", file=sys.stderr)
        pairs += found
    pairs = unique(pairs)
    print(f"distinct pairs to send: {len(pairs)}")

    if not args.apply:
        for a, b in pairs[:10]:
            print(f"  {a} blocked {b}")
        print("dry run: nothing sent. Re-run with --apply to import.")
        return 0
    token = os.environ.get("SOCIAL_INTERNAL_TOKEN", "").strip()
    if not token:
        print("SOCIAL_INTERNAL_TOKEN is not set in the environment.", file=sys.stderr)
        return 2
    totals = run(pairs, http_sender(args.social_url, token))
    print(f"done: {totals}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
