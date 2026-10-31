"""The browser coach's push-up demo creates its profile with DEMO_PROFILE from
frontend-react/src/flow/demoSession.ts. Its fields must pass the profile model POST /api/users
validates with — when the backend narrowed `gender` to a fixed vocabulary, the demo kept sending
'unspecified' and every fresh demo stopped at "Could not create profile (422)". This reads the
frontend file itself, so the two can't drift again.

Account rules (a password when sign-in is required, an allowed email domain) are a separate,
open question for the demo and are not asserted here.
"""

from __future__ import annotations

import json
import re

from backend import config
from backend.profiles.vocab import GENDERS
from backend.users.router import UserProfile

_DEMO_SESSION_TS = config._REPO_ROOT / "frontend-react" / "src" / "flow" / "demoSession.ts"


def _demo_profile() -> dict:
    """The DEMO_PROFILE object literal (flat: string and number values), parsed from the source."""
    source = _DEMO_SESSION_TS.read_text(encoding="utf-8")
    block = re.search(r"export const DEMO_PROFILE = \{(.*?)\n\}", source, flags=re.S)
    assert block, "DEMO_PROFILE not found in demoSession.ts"
    fields = {}
    for key, raw in re.findall(r"^\s*(\w+):\s*(.+?),?\s*$", block.group(1), flags=re.M):
        fields[key] = json.loads(raw.replace("'", '"'))
    return fields


def test_demo_profile_uses_the_backend_gender_vocabulary():
    assert _demo_profile()["gender"] in GENDERS


def test_demo_profile_passes_the_sign_up_profile_model():
    UserProfile.model_validate(_demo_profile())  # raises on any field the backend would 422
