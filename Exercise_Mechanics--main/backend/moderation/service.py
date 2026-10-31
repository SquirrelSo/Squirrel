"""Filing reports (members) and reviewing them (moderators)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from backend.moderation import policy, store
from backend.moderation.store import UnreadableReport
from backend.sessions.store import read_session_record
from backend.users.store import read_profile


class ModerationError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id(moment: datetime) -> str:
    return f"rpt_{moment.strftime('%Y%m%dT%H%M%S')}_{uuid.uuid4().hex[:10]}"


# ---------------------------------------------------------------- members

def file_report(reporter_id: str, request: dict, *, now: datetime | None = None) -> tuple[dict, bool]:
    """File a report. Returns (report, created). Re-reporting the same thing in the same category
    while the first report is still under review returns that report instead of a duplicate."""
    moment = now or _now()
    if read_profile(reporter_id) is None:
        raise ModerationError(404, "user_not_found", "No such user.")

    target_user = request["reported_user_id"]
    if target_user == reporter_id:
        raise ModerationError(400, "invalid_target", "You cannot report yourself.")
    if read_profile(target_user) is None:
        raise ModerationError(404, "reported_user_not_found", "The member you are reporting does not exist.")
    session_id = request.get("session_id")
    if session_id is not None:
        record = read_session_record(target_user, session_id)
        if record is None or record.get("user_id") != target_user:
            raise ModerationError(404, "session_not_found", "That session does not belong to the reported member.")
    target = ({"type": "session", "user_id": target_user, "session_id": session_id}
              if session_id else {"type": "user", "user_id": target_user})

    mine = [r for r in store.all_reports()[0] if r.get("reporter_id") == reporter_id]
    for existing in mine:
        if (existing.get("target") == target and existing.get("category") == request["category"]
                and existing.get("status") in policy.ACTIVE_STATUSES):
            return _member_view(existing), False
    since = moment - timedelta(hours=24)
    recent = [r for r in mine if _parse(r.get("created_at")) >= since]
    if len(recent) >= policy.DAILY_LIMIT:
        raise ModerationError(429, "report_limit", "You've sent a lot of reports today. Please try again tomorrow.")

    stamp = moment.isoformat()
    report = {
        "report_id": _new_id(moment),
        "reporter_id": reporter_id,
        "target": target,
        "category": request["category"],
        "description": request.get("description"),
        "source": request.get("source"),
        "status": "open",
        "created_at": stamp,
        "updated_at": stamp,
        "resolution_note": None,
        "history": [{"status": "open", "at": stamp, "by": "reporter", "note": None}],
    }
    store.write_report(report)
    return _member_view(report), True


def my_reports(reporter_id: str) -> list[dict]:
    """The member's own reports, newest first, with their review status."""
    if read_profile(reporter_id) is None:
        raise ModerationError(404, "user_not_found", "No such user.")
    mine = [r for r in store.all_reports()[0] if r.get("reporter_id") == reporter_id]
    return [_member_view(r) for r in sorted(mine, key=_newest_first)]


def _member_view(report: dict) -> dict:
    """What the reporter sees: their own report and its status — not moderator notes or history."""
    return {key: report.get(key) for key in
            ("report_id", "target", "category", "description", "source", "status", "created_at", "updated_at")}


# ---------------------------------------------------------------- moderators

def review_queue(*, status: str | None = None, category: str | None = None,
                 reported_user_id: str | None = None) -> dict:
    """Reports for review, newest first, each with how many reports the same member has against them."""
    reports, unreadable = store.all_reports()
    against: dict[str, int] = {}
    for r in reports:
        user = (r.get("target") or {}).get("user_id")
        if user:
            against[user] = against.get(user, 0) + 1
    selected = [
        r for r in reports
        if (status is None or r.get("status") == status)
        and (category is None or r.get("category") == category)
        and (reported_user_id is None or (r.get("target") or {}).get("user_id") == reported_user_id)
    ]
    return {
        "reports": [{**r, "reports_against_member": against.get((r.get("target") or {}).get("user_id"), 0)}
                    for r in sorted(selected, key=_newest_first)],
        "unreadable": unreadable,
    }


def get_report(report_id: str) -> dict:
    try:
        report = store.read_report(report_id)
    except UnreadableReport as exc:
        raise ModerationError(500, "report_unreadable", "This report's file can't be read.") from exc
    if report is None:
        raise ModerationError(404, "report_not_found", "No such report.")
    return report


def update_status(report_id: str, status: str, note: str | None, *, now: datetime | None = None) -> dict:
    """Move a report through review. Every change is kept in the report's history."""
    report = get_report(report_id)
    if status == report.get("status"):
        raise ModerationError(409, "no_change", f"The report is already {status}.")
    stamp = (now or _now()).isoformat()
    report["status"] = status
    report["updated_at"] = stamp
    if status in ("resolved", "dismissed"):
        report["resolution_note"] = note
    report["history"] = [*report.get("history", []), {"status": status, "at": stamp, "by": "moderator", "note": note}]
    store.write_report(report)
    return report


def _parse(raw: object) -> datetime:
    try:
        moment = datetime.fromisoformat(str(raw))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _newest_first(report: dict) -> tuple:
    return (-_parse(report.get("created_at")).timestamp(), report.get("report_id", ""))
