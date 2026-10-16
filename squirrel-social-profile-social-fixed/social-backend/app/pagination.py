"""Opaque keyset cursors: base64url("<iso timestamp>|<id>"). Lists are ordered by
(timestamp DESC, id DESC) (comments: ASC), so a page is one index range scan."""

from __future__ import annotations

import base64
import uuid
from datetime import datetime

from sqlalchemy import and_, or_

from app.errors import invalid

DEFAULT_LIMIT = 20
MAX_LIMIT = 50


def encode_cursor(ts: datetime, key: object) -> str:
    raw = f"{ts.isoformat()}|{key}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        ts_raw, key = base64.urlsafe_b64decode(padded.encode()).decode().split("|", 1)
        ts = datetime.fromisoformat(ts_raw)
        if ts.tzinfo is None or not key:
            raise ValueError
        return ts, key
    except (ValueError, UnicodeDecodeError):
        raise invalid("Invalid cursor.", "invalid_cursor") from None


def decode_uuid_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    ts, key = decode_cursor(cursor)
    try:
        return ts, uuid.UUID(key)
    except ValueError:
        raise invalid("Invalid cursor.", "invalid_cursor") from None


def clamp_limit(limit: int | None) -> int:
    return max(1, min(MAX_LIMIT, limit or DEFAULT_LIMIT))


def before(ts_col, key_col, cursor_ts: datetime, cursor_key):
    """Rows strictly after the cursor in (ts DESC, key DESC) order."""
    return or_(ts_col < cursor_ts, and_(ts_col == cursor_ts, key_col < cursor_key))


def after(ts_col, key_col, cursor_ts: datetime, cursor_key):
    """Rows strictly after the cursor in (ts ASC, key ASC) order."""
    return or_(ts_col > cursor_ts, and_(ts_col == cursor_ts, key_col > cursor_key))
