"""Names, photos and public profile ids, asked of the Social service, which owns them (ADR-032).

    POST {SOCIAL_API_URL}/internal/v1/people/resolve   { subjects: [sub…] } → { people: [InternalPerson] }

The app only ever sees Social profile ids, never the login `sub`, so anything Exercise shows about a
person to someone else goes through this call. Social provisions a subject it has not seen, so every
subject sent comes back. Same service token and settings as social_blocks.py.

Failure policy: SocialUnreachable on any failure (unreachable, timeout, non-2xx, a malformed answer, a
subject missing from the answer, the settings unset). The caller refuses the action rather than show
someone under a made-up name.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

from backend import social_publish

log = logging.getLogger(__name__)

RESOLVE_PATH = "/internal/v1/people/resolve"
TIMEOUT_S = 5

# Seam for tests: the HTTP opener.
_urlopen = urllib.request.urlopen


class SocialUnreachable(RuntimeError):
    """Social could not be asked, or did not answer usably."""


def resolve(subjects: list[str]) -> dict[str, dict]:
    """Login subjects → the app's PersonLite for each: {user_id (Social profile id), display_name,
    avatar_url, hostel}. Every subject asked for is in the answer, or this raises."""
    subjects = list(dict.fromkeys(subjects))
    if not subjects:
        return {}
    body = _call(RESOLVE_PATH, {"subjects": subjects})
    people = body.get("people") if isinstance(body, dict) else None
    if not isinstance(people, list):
        raise SocialUnreachable("Social answered people/resolve in an unexpected shape")
    found: dict[str, dict] = {}
    for row in people:
        if not (isinstance(row, dict) and isinstance(row.get("subject"), str) and isinstance(row.get("profile_id"), str)
                and isinstance(row.get("display_name"), str)):
            raise SocialUnreachable("Social answered people/resolve in an unexpected shape")
        found[row["subject"]] = {
            "user_id": row["profile_id"],
            "display_name": row["display_name"],
            "avatar_url": row.get("avatar_url") if isinstance(row.get("avatar_url"), str) else None,
            "hostel": row.get("hostel") if isinstance(row.get("hostel"), str) else None,
        }
    missing = [s for s in subjects if s not in found]
    if missing:
        raise SocialUnreachable(f"Social did not resolve {len(missing)} subject(s)")
    return found


def _call(path: str, payload: dict) -> object:
    target = social_publish.configured()
    if target is None:
        log.error("people cannot be resolved: SOCIAL_API_URL and SOCIAL_INTERNAL_TOKEN must both be set")
        raise SocialUnreachable("Social is not configured")
    url, token = target
    request = urllib.request.Request(
        url + path, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        with _urlopen(request, timeout=TIMEOUT_S) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        log.warning("Social refused people/resolve: HTTP %s", exc.code)
        raise SocialUnreachable(f"Social answered HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log.warning("Social unreachable for people/resolve: %s", exc)
        raise SocialUnreachable("Social is unreachable") from exc
    except (ValueError, UnicodeDecodeError) as exc:
        raise SocialUnreachable("Social returned invalid JSON") from exc
