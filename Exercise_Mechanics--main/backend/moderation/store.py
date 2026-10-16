"""Report persistence: one JSON file per report, written atomically."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from backend import config
from backend.sessions.store import _atomic_write_json

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
REPORT_ID_RE = re.compile(r"^rpt_[0-9]{8}T[0-9]{6}_[0-9a-f]{10}$")


def _path(report_id: str) -> Path:
    return config.REPORTS_DIR / f"{report_id}.json"


def write_report(report: dict) -> None:
    _atomic_write_json(_path(report["report_id"]), {"schema_version": SCHEMA_VERSION, "report": report})


def read_report(report_id: str) -> dict | None:
    if not REPORT_ID_RE.fullmatch(report_id):
        return None
    try:
        with open(_path(report_id), encoding="utf-8") as handle:
            report = json.load(handle)["report"]
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise UnreadableReport(report_id) from exc
    if not isinstance(report, dict):
        raise UnreadableReport(report_id)
    return report


def all_reports() -> tuple[list[dict], list[str]]:
    """(readable reports, ids of unreadable ones). Unreadable reports are surfaced, never dropped
    silently: a moderator must be able to see that something is there."""
    root = config.REPORTS_DIR
    if not root.exists():
        return [], []
    reports, unreadable = [], []
    for path in sorted(root.glob("rpt_*.json")):
        report_id = path.stem
        try:
            report = read_report(report_id)
        except UnreadableReport:
            log.error("unreadable report file %s", path.name)
            unreadable.append(report_id)
            continue
        if report is not None:
            reports.append(report)
    return reports, unreadable


class UnreadableReport(RuntimeError):
    """A report file exists but cannot be read."""
