"""Persisted nearby state — only what a user explicitly chose.

    users/<id>/nearby.json       {enabled, show_profile, updated_at}   opt-in, default OFF
    users/<id>/connections.json  {outgoing: [...], incoming: [...], connected: [...]}

Connections deliberately carry no time or place: they record that two people chose to connect,
not when or where they were near each other.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from backend.config import user_dir
from backend.users.store import read_profile

NEARBY_FILENAME      = "nearby.json"
CONNECTIONS_FILENAME = "connections.json"

ConnectionStatus = Literal["none", "requested", "incoming", "connected"]

_lock = threading.RLock()


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def _read_json(path: Path) -> dict:
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# --- settings ----------------------------------------------------------------

def read_settings(user_id: str) -> dict:
    data = _read_json(user_dir(user_id) / NEARBY_FILENAME)
    return {"enabled": data.get("enabled") is True, "show_profile": data.get("show_profile") is True}


def write_settings(user_id: str, *, enabled: bool, show_profile: bool) -> dict:
    record = {"enabled": enabled, "show_profile": show_profile,
              "updated_at": datetime.now(timezone.utc).isoformat()}
    with _lock:
        _atomic_write_json(user_dir(user_id) / NEARBY_FILENAME, record)
    return {"enabled": enabled, "show_profile": show_profile}


def is_enabled(user_id: str) -> bool:
    return read_settings(user_id)["enabled"]


# --- public profile ----------------------------------------------------------

def display_name(user_id: str) -> str | None:
    """First name + last initial — never email, phone or full surname."""
    profile = read_profile(user_id) or {}
    first = str(profile.get("first_name") or "").strip()
    last = str(profile.get("last_name") or "").strip()
    if not first:
        return None
    return f"{first} {last[0]}." if last else first


# --- connections -------------------------------------------------------------

def _connections(user_id: str) -> dict:
    data = _read_json(user_dir(user_id) / CONNECTIONS_FILENAME)
    return {k: list(data.get(k, [])) for k in ("outgoing", "incoming", "connected")}


def _save_connections(user_id: str, data: dict) -> None:
    _atomic_write_json(user_dir(user_id) / CONNECTIONS_FILENAME, data)


def connection_status(user_id: str, other_id: str) -> ConnectionStatus:
    data = _connections(user_id)
    if other_id in data["connected"]:
        return "connected"
    if other_id in data["outgoing"]:
        return "requested"
    if other_id in data["incoming"]:
        return "incoming"
    return "none"


def request_connection(user_id: str, other_id: str) -> ConnectionStatus:
    """Record user → other. If other had already asked, both become connected."""
    with _lock:
        mine, theirs = _connections(user_id), _connections(other_id)
        if other_id in mine["connected"]:
            return "connected"
        if other_id in mine["incoming"]:
            mine["incoming"].remove(other_id)
            theirs["outgoing"] = [u for u in theirs["outgoing"] if u != user_id]
            mine["connected"].append(other_id)
            theirs["connected"].append(user_id)
            status: ConnectionStatus = "connected"
        else:
            if other_id not in mine["outgoing"]:
                mine["outgoing"].append(other_id)
            if user_id not in theirs["incoming"]:
                theirs["incoming"].append(user_id)
            status = "requested"
        _save_connections(user_id, mine)
        _save_connections(other_id, theirs)
        return status


def connected_users(user_id: str) -> list[str]:
    return _connections(user_id)["connected"]
