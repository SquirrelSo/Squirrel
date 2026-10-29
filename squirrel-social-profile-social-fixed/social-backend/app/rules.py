"""Input rules shared by every endpoint. The mobile app mirrors these in
`mobile/src/api/socialRules.ts`; keep the two in step.
"""

from __future__ import annotations

import re

# --- usernames ------------------------------------------------------------------------------
# 3–20 chars, lowercase letters, digits, '.' and '_'; starts with a letter; no '..' and does not
# end with '.' (handles like "aanya.moves" and "isha.eats.clean" are valid).
USERNAME_MIN = 3
USERNAME_MAX = 20
USERNAME_RE = re.compile(r"^[a-z][a-z0-9._]{2,19}$")
RESERVED_USERNAMES = frozenset(
    {
        "admin", "administrator", "api", "app", "help", "me", "mod", "moderator", "null", "official",
        "root", "settings", "squirrel", "squirrelsocial", "staff", "support", "system", "undefined", "username",
    }
)


def normalize_username(raw: str) -> str:
    return raw.strip().lower()


def username_problem(username: str) -> str | None:
    """Return a human-readable reason the (normalised) username is invalid, or None."""
    if not (USERNAME_MIN <= len(username) <= USERNAME_MAX):
        return f"Username must be {USERNAME_MIN}–{USERNAME_MAX} characters."
    if not USERNAME_RE.fullmatch(username):
        return "Use lowercase letters, numbers, '.' or '_', starting with a letter."
    if ".." in username or username.endswith("."):
        return "Dots can't be doubled or come last."
    if username in RESERVED_USERNAMES:
        return "That username is reserved."
    return None


# --- catalogues (ids match the app's data/cities.ts, types.ts and art) -------------------------
CITY_IDS = frozenset({"pune", "mumbai", "bangalore", "delhi", "hyderabad", "london", "nyc"})

SCENES = frozenset(
    {"city-sunset", "city-night", "city-dawn", "run", "yoga", "cafe", "brunch", "crew", "hiit", "cycling", "lake", "rooftop", "stadium"}
)
POST_STICKERS = frozenset({"one-more-km", "fire", "good-vibes", "neon-heart", "squirrel-flex", "hydrate"})
ACTIVITY_TYPES = ("run", "ride", "workout", "yoga", "meal")
# Runs must come from the Run Module (server-measured). Everything else may be self-reported.
MANUAL_ACTIVITY_TYPES = ("ride", "workout", "yoga", "meal")

CAPTION_MAX = 280
COMMENT_MAX = 500
BIO_MAX = 160
DISPLAY_NAME_MAX = 40
INTERESTS_MAX = 8
INTEREST_MAX_LEN = 24
AREA_MAX = 60
COLLEGE_MAX = 80
CREW_NAME_MAX = 60

# Avatar look (mirrors AvatarLook in mobile/src/types.ts).
AVATAR_ENUMS = {
    "body": {"female", "male"},
    "hair": {"bun", "long", "ponytail", "short", "curly", "buzz", "afro", "bob"},
    "top": {"hoodie", "tee", "crop", "tank", "jacket"},
    "bottom": {"joggers", "shorts", "leggings"},
    "accessory": {"none", "shades", "cap", "headphones", "headband"},
}
AVATAR_COLORS = ("skin", "hairColor", "topColor", "bottomColor", "shoeColor")
HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def avatar_look_problem(look: dict) -> str | None:
    expected = set(AVATAR_ENUMS) | set(AVATAR_COLORS)
    if set(look) != expected:
        return "avatar_look must have exactly: " + ", ".join(sorted(expected))
    for k, allowed in AVATAR_ENUMS.items():
        if look[k] not in allowed:
            return f"avatar_look.{k} is not a known option."
    for k in AVATAR_COLORS:
        if not isinstance(look[k], str) or not HEX_COLOR_RE.fullmatch(look[k]):
            return f"avatar_look.{k} must be a #RRGGBB colour."
    return None


CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_text(value: str) -> str:
    """Strip surrounding whitespace and control characters (newlines and tabs are kept)."""
    return CONTROL_CHARS_RE.sub("", value).strip()


AMBASSADOR_FORM_VERSION = 1
AMBASSADOR_FORM = [
    {"key": "why", "label": "Why do you want to be an ambassador?", "type": "multiline", "required": True, "max_length": 500},
    {"key": "ideas", "label": "What ideas do you have?", "type": "multiline", "required": True, "max_length": 500},
    {"key": "hostel", "label": "Your hostel", "type": "text", "required": False, "max_length": 40},
    {"key": "role", "label": "Current role", "type": "select", "required": True, "options": ["Student", "Alumni", "Faculty"]},
]
