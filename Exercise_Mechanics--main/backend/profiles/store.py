"""Profile-detail persistence, one file per category in the user's directory:

    data/users/<id>/fitness.json       activity level, primary goal (fitness level stays in skill.json)
    data/users/<id>/activities.json    declared activities
    data/users/<id>/physique.json      body type                      (consent: physique)
    data/users/<id>/habits.json        schedule, sleep, diet, …       (consent: habits)
    data/users/<id>/measurements.json  height / weight / body-fat / waist history
    data/users/<id>/consents.json      append-only consent log
    data/users/<id>/personal_details.json  personal email, course, CGPA ("About you")

Separate files mirror the separate tables in the agreed schema: each sensitive category can be
erased on its own when its consent is withdrawn.

With DATABASE_URL set, each of these is instead one row of user_profile_data (kind = the category,
data = the same JSON; see db/accounts.py), so they survive a redeploy. Personal details are instead a
row of their own table, user_personal_details (migration 006).
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from backend import config
from backend.db import accounts as db_accounts
from backend.db import connection

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
FITNESS_FILENAME = "fitness.json"
ACTIVITIES_FILENAME = "activities.json"
PHYSIQUE_FILENAME = "physique.json"
HABITS_FILENAME = "habits.json"
MEASUREMENTS_FILENAME = "measurements.json"
CONSENTS_FILENAME = "consents.json"
PERSONAL_DETAILS_FILENAME = "personal_details.json"
PERSONAL_DETAILS_FIELDS = ("personal_email", "course", "cgpa")

_SECTIONS = {
    "fitness": (FITNESS_FILENAME, dict),
    "activities": (ACTIVITIES_FILENAME, list),
    "physique": (PHYSIQUE_FILENAME, dict),
    "habits": (HABITS_FILENAME, dict),
}


class HistoryUnreadable(RuntimeError):
    """An append-only file (measurements or consents) exists but cannot be read.

    Never treated as empty: appending to it would overwrite the history, and for consents it would
    also mean acting on a consent state we cannot confirm.
    """


def _path(user_id: str, filename: str) -> Path:
    return config.user_dir(user_id) / filename


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- replaceable sections

def read_section(user_id: str, section: str) -> dict | list | None:
    """A saved section, or None when unanswered. A corrupt file reads as unanswered (with a
    warning): the user is simply asked again, and nothing is inferred from half a file."""
    filename, kind = _SECTIONS[section]
    try:
        if connection.enabled():
            document = db_accounts.read_data(user_id, section)
            if document is None:
                return None
            value = document[section]
        else:
            path = _path(user_id, filename)
            if not path.exists():
                return None
            with open(path, encoding="utf-8") as handle:
                value = json.load(handle)[section]
    except (OSError, ValueError, KeyError, TypeError):
        log.warning("unreadable %s for %s; treating as unanswered", filename, user_id)
        return None
    return value if isinstance(value, kind) else None


def write_section(user_id: str, section: str, value: dict | list) -> None:
    filename, _ = _SECTIONS[section]
    document = {"schema_version": SCHEMA_VERSION, section: value, "updated_at": _now()}
    if connection.enabled():
        db_accounts.write_data(user_id, section, document)
    else:
        _atomic_write_json(_path(user_id, filename), document)


def erase_section(user_id: str, section: str) -> None:
    filename, _ = _SECTIONS[section]
    if connection.enabled():
        db_accounts.delete_data(user_id, section)
    else:
        _path(user_id, filename).unlink(missing_ok=True)


# ---------------------------------------------------------------- append-only histories

# (database kind, file name, list key) of each history.
_MEASUREMENTS = ("measurements", MEASUREMENTS_FILENAME, "measurements")
_CONSENTS = ("consents", CONSENTS_FILENAME, "events")


def _history_items(document: object, where: str, key: str) -> list[dict]:
    try:
        items = document[key]  # type: ignore[index]
    except (KeyError, TypeError) as exc:
        raise HistoryUnreadable(where) from exc
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise HistoryUnreadable(where)
    return items


def _read_history(user_id: str, history: tuple[str, str, str]) -> list[dict]:
    kind, filename, key = history
    if connection.enabled():
        document = db_accounts.read_data(user_id, kind)
        return [] if document is None else _history_items(document, f"{kind} for {user_id}", key)
    path = _path(user_id, filename)
    if not path.exists():
        return []
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError) as exc:
        raise HistoryUnreadable(f"{filename} for {user_id}") from exc
    return _history_items(document, f"{filename} for {user_id}", key)


def _write_history(user_id: str, history: tuple[str, str, str], items: list[dict]) -> None:
    kind, filename, key = history
    document = {"schema_version": SCHEMA_VERSION, key: items}
    if connection.enabled():
        db_accounts.write_data(user_id, kind, document)
    else:
        _atomic_write_json(_path(user_id, filename), document)


def read_measurements(user_id: str) -> list[dict]:
    return _read_history(user_id, _MEASUREMENTS)


def has_measurement_history(user_id: str) -> bool:
    """Whether a measurement history has ever been written, even one since emptied by an erasure."""
    if connection.enabled():
        return db_accounts.read_data(user_id, _MEASUREMENTS[0]) is not None
    return _path(user_id, MEASUREMENTS_FILENAME).exists()


def write_measurements(user_id: str, measurements: list[dict]) -> None:
    _write_history(user_id, _MEASUREMENTS, measurements)


def read_consent_events(user_id: str) -> list[dict]:
    return _read_history(user_id, _CONSENTS)


def append_consent_event(user_id: str, event: dict) -> list[dict]:
    """Append one event. Raises HistoryUnreadable instead of replacing a log it could not read."""
    if connection.enabled():
        kind, _, key = _CONSENTS
        # One statement: two decisions made at once are both kept.
        document = db_accounts.append_to_list(user_id, kind, key, event, {"schema_version": SCHEMA_VERSION})
        return _history_items(document, f"{kind} for {user_id}", key)
    events = read_consent_events(user_id) + [event]
    _write_history(user_id, _CONSENTS, events)
    return events


# ---------------------------------------------------------------- personal details ("About you")

def read_personal_details(user_id: str) -> dict | None:
    """The saved personal email, course and CGPA, or None before the first save. A corrupt file
    reads as unsaved (with a warning), like a section."""
    if connection.enabled():
        return db_accounts.read_personal_details(user_id)
    path = _path(user_id, PERSONAL_DETAILS_FILENAME)
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
        return {field: document[field] for field in PERSONAL_DETAILS_FIELDS}
    except (OSError, ValueError, KeyError, TypeError):
        log.warning("unreadable %s for %s; treating as unsaved", PERSONAL_DETAILS_FILENAME, user_id)
        return None


def write_personal_details(user_id: str, details: dict) -> None:
    saved = {field: details[field] for field in PERSONAL_DETAILS_FIELDS}
    if connection.enabled():
        db_accounts.write_personal_details(user_id, saved)
    else:
        _atomic_write_json(_path(user_id, PERSONAL_DETAILS_FILENAME),
                           {"schema_version": SCHEMA_VERSION, **saved, "updated_at": _now()})


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write-then-rename, so a crash mid-write leaves the previous file rather than half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
