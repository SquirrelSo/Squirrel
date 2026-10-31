"""Read-only report builder + endpoints over a synthetic persisted session."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI

from backend import config
from backend.reports import builder
from backend.reports.router import router as reports_router

_UID = "aanand-r-abc123"
_SID = "20260717T151141-abc123"

_TEMPLATES = {
    "knee_valgus": {
        "fault_label": "Knee valgus",
        "issue": "Knees collapse inward.",
        "cue": "Push knees out.",
        "coaching": "Drive your knees out over your toes as you stand.",
        "scoring": {"role": "penalty"},
    },
    "depth": {
        "fault_label": "Short depth",
        "issue": "The squat does not reach depth.",
        "cue": "Go deeper.",
        "coaching": "Sit down until your hips reach the top of your knees.",
        "full_rom_gate": 0.85,
        "scoring": {"role": "rom"},
    },
}


def _phase(rules: dict) -> dict:
    return {"rules": rules}


def _clean_rules() -> dict:
    return {
        "knee_valgus": {"role": "penalty", "weighted_penalty": 0.0, "not_ok_fraction": 0.0},
        "depth": {"role": "rom", "weighted_penalty": 0.0, "not_ok_fraction": 0.0},
    }


def _form_score(rep: int, score: float, classification: str, peak: float,
                rom_factor: float, valgus_penalty: float) -> dict:
    ascent_rules = _clean_rules()
    ascent_rules["knee_valgus"] = {
        "role": "penalty",
        "weighted_penalty": valgus_penalty,
        "not_ok_fraction": 0.5 if valgus_penalty else 0.0,
    }
    return {
        "schema_version": 1, "set": 1, "rep": rep,
        "final_score": score,
        "phase_scores": {
            "descent": _phase(_clean_rules()),
            "bottom": _phase(_clean_rules()),
            "ascent": _phase(ascent_rules),
        },
        "last_rep": {"rep": rep, "qualified": True, "classification": classification,
                     "peak": peak, "rom_factor": rom_factor},
        "movement_duration_ms": 2000.0,
    }


@pytest.fixture
def user_id(tmp_path, monkeypatch) -> str:
    monkeypatch.setattr(config, "USERS_DIR", tmp_path)
    session_dir = tmp_path / _UID / "sessions" / _SID
    (session_dir).mkdir(parents=True)
    (session_dir / "session.json").write_text(json.dumps({
        "created_at": "2026-07-17T15:11:41+00:00",
        "skill_level": "beginner",
        "session_id": _SID,
        "user_id": _UID,
        "plan": {
            "exercise_id": "squat", "exercise_name": "Squat", "sets": 1,
            "target": {"type": "reps", "value": 3},
            "metadata": {"body_part": "Lower Body", "training_tag": "Strength", "view": "front"},
        },
    }))
    set_dir = session_dir / "workouts" / "squat" / "set_1"
    set_dir.mkdir(parents=True)
    (set_dir / "set_summary.json").write_text(json.dumps({
        "average_form_score": 76.7, "completed_reps": 3, "active_movement_ms": 6000.0,
    }))
    # rep 1 clean, rep 2 shallow (depth), rep 3 knee valgus fault
    faults = [
        (1, 100.0, "full_rom", 1.1, 1.0, 0.0),
        (2, 60.0, "shallow", 0.5, 0.6, 0.0),
        (3, 70.0, "full_rom", 1.1, 1.0, 0.30),
    ]
    for rep, score, cls, peak, rom_factor, valgus in faults:
        rep_dir = set_dir / f"rep_{rep}"
        rep_dir.mkdir()
        (rep_dir / "form_score.json").write_text(json.dumps(_form_score(rep, score, cls, peak, rom_factor, valgus)))
        (rep_dir / "metadata.json").write_text(json.dumps({"templates": _TEMPLATES}))
    return _UID


def _get(app: FastAPI, path: str) -> tuple[int, dict]:
    messages: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        messages.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": "GET", "scheme": "http", "path": path, "raw_path": path.encode(),
        "query_string": b"", "root_path": "",
        "headers": [(b"host", b"test")], "client": ("127.0.0.1", 12345), "server": ("test", 80),
    }
    asyncio.run(app(scope, receive, send))
    start = next(m for m in messages if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return start["status"], json.loads(body)


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(reports_router)
    return app


def test_session_report_summary_and_faults(user_id):
    report = builder.build_session_report(user_id, _SID)
    assert report is not None
    assert report["exercise_id"] == "squat"
    assert report["planned"] == {"sets": 1, "reps_per_set": 3, "total": 3, "weight_kg": None}
    assert report["actual"] == {"reps_completed": 3, "sets_completed": 1}
    assert report["depth_target"] == 85
    s = report["summary"]
    assert (s["total_reps"], s["shallow_reps"], s["best"], s["worst"]) == (3, 1, 100, 60)
    assert s["avg_form_score"] == pytest.approx((100 + 60 + 70) / 3, abs=0.1)

    rules = {r["rule"]: r for r in report["by_rule"]}
    assert rules["depth"]["flagged_reps"] == 1
    assert rules["knee_valgus"]["flagged_reps"] == 1
    assert rules["lateral_torso_lean"]["flagged_reps"] == 0 if "lateral_torso_lean" in rules else True

    coaching = {c["rule"]: c for c in report["coaching"]}
    assert coaching["depth"]["reps"] == [2]
    assert coaching["knee_valgus"]["reps"] == [3]
    # Coaching text comes verbatim from the YAML-sourced template config, not the frontend.
    assert coaching["knee_valgus"]["fix"] == _TEMPLATES["knee_valgus"]["coaching"]


def test_overview_quality_buckets(user_id):
    overview = builder.build_overview(user_id, _SID)
    assert overview["total_reps"] == 3
    assert overview["session_score"] == 77
    ex = overview["exercises"][0]
    assert ex["quality"] == {"good": 1, "borderline": 2, "poor": 0}
    assert ex["shallow_reps"] == 1


def test_progress_and_sessions_list(user_id):
    listing = builder.list_sessions(user_id)
    assert listing == [{
        # 15:11 UTC, shown on the person's clock: no zone stored, so the default (Asia/Kolkata)
        "session_id": _SID, "date": "2026-07-17", "day": "Fri", "start_time": "20:41",
        "exercise": "Squat", "reps_completed": 3,
    }]
    progress = builder.build_progress(user_id)
    assert progress["totals"] == {"sessions": 1, "reps": 3, "with_data": 1}
    assert progress["avg_form"] == 77
    assert builder.build_activity(user_id, 2026) == ["2026-07-17"]
    assert builder.build_activity(user_id, 2025) == []


def test_endpoints_serve_and_404(user_id):
    app = _app()
    status, report = _get(app, f"/api/users/{user_id}/sessions/{_SID}/report")
    assert status == 200 and report["exercise_id"] == "squat"

    status, overview = _get(app, f"/api/users/{user_id}/sessions/{_SID}/overview")
    assert status == 200 and overview["exercise_count"] == 1

    status, sessions = _get(app, f"/api/users/{user_id}/sessions")
    assert status == 200 and len(sessions["sessions"]) == 1

    status, _ = _get(app, f"/api/users/{user_id}/sessions/{_SID}/exercises/squat/report")
    assert status == 200

    status, _ = _get(app, f"/api/users/{user_id}/sessions/does-not-exist/report")
    assert status == 404
    status, _ = _get(app, f"/api/users/{user_id}/sessions/{_SID}/exercises/pushup/report")
    assert status == 404


def test_timed_report_uses_configured_duration_for_completed_sets(tmp_path):
    workout_dir = tmp_path / "high_knee"
    for set_no, drifted_duration in ((1, 21_000), (2, 35_000)):
        set_dir = workout_dir / f"set_{set_no}"
        set_dir.mkdir(parents=True)
        (set_dir / "set_summary.json").write_text(
            json.dumps(
                {
                    "movement_type": "time",
                    "status": "complete",
                    "target_duration_ms": 30_000,
                    "elapsed_ms": drifted_duration,
                    "set_duration_ms": drifted_duration,
                    "average_form_score": 100.0,
                    "monitors": {
                        "left_right_asymmetry": {
                            "status": "asymmetric" if set_no == 1 else "balanced",
                            "lower_side": "right" if set_no == 1 else None,
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

    report = builder._timed_exercise_report(
        {
            "created_at": "2026-07-21T10:00:00Z",
            "skill_level": "beginner",
            "plan": {
                "exercise_id": "high_knee",
                "exercise_name": "High Knees",
                "sets": 2,
                "target": {"type": "time", "value_ms": 30_000},
                "metadata": {},
            },
        },
        "timed-session",
        "high_knee",
        workout_dir,
    )

    assert report["planned"]["duration_seconds"] == 30.0
    assert report["summary"]["total_time_s"] == 60.0
    assert [item["time_s"] for item in report["per_set"]] == [30.0, 30.0]
    assert report["summary"]["asymmetry_sets"] == 1
    assert report["per_set"][0]["left_right_asymmetry"]["lower_side"] == "right"
    assert any("Uneven left/right knee travel" in item for item in report["insights"])


def test_attempts_that_did_not_count_are_shown_but_are_not_reps(user_id, tmp_path):
    """Field test: every shallow squat counted and paid. An attempt the counting policy rejected
    writes its form_score.json too; the report must tally it by reason, not as a rep."""
    set_dir = tmp_path / _UID / "sessions" / _SID / "workouts" / "squat" / "set_1"
    for rep, reason in ((4, "shallow"), (5, "too_fast"), (6, "shallow")):
        rep_dir = set_dir / f"rep_{rep}"
        rep_dir.mkdir()
        document = _form_score(rep, 0.0, "invalid", 0.6, 0.6, 0.0)
        document["final_score"] = None
        document["last_attempt"] = {"attempt": rep, "rep": None, "qualified": False,
                                    "classification": "invalid", "reason": reason, "peak": 0.6}
        document["last_rep"] = {"rep": 3, "qualified": True, "classification": "full_rom", "peak": 1.1}
        (rep_dir / "form_score.json").write_text(json.dumps(document))
    report = builder.build_session_report(user_id, _SID)
    assert report["actual"]["reps_completed"] == 3
    s = report["summary"]
    assert s["total_reps"] == 3 and s["good_reps"] == 2
    assert s["not_counted"] == {"shallow": 2, "too_fast": 1, "other": 0}
    assert s["shallow_reps"] == 1 + 2
    assert len(report["per_rep"]) == 3
    assert report["activity_metrics"]["reps_not_counted"] == 3


def _move_session(user_id, tmp_path, created_at: str, time_zone: str | None) -> None:
    path = tmp_path / user_id / "sessions" / _SID / "session.json"
    record = json.loads(path.read_text())
    record["created_at"] = created_at
    if time_zone:
        record["timezone"] = time_zone
    path.write_text(json.dumps(record))


def test_a_late_night_workout_is_on_the_persons_own_day(user_id, tmp_path):
    """Field test: phone 20:08, saved session 14:34 (UTC). A workout at 00:30 IST is 19:00 UTC the
    day before; it belongs to the IST day."""
    _move_session(user_id, tmp_path, "2026-07-16T19:00:00+00:00", "Asia/Kolkata")
    row = builder.list_sessions(user_id)[0]
    assert (row["date"], row["day"], row["start_time"]) == ("2026-07-17", "Fri", "00:30")
    report = builder.build_session_report(user_id, _SID)
    assert (report["date"], report["start_time"]) == ("2026-07-17", "00:30")
    assert builder.build_activity(user_id, 2026) == ["2026-07-17"]


def test_the_phones_zone_wins_over_the_default(user_id, tmp_path):
    _move_session(user_id, tmp_path, "2026-07-16T19:00:00+00:00", "America/New_York")
    assert builder.list_sessions(user_id)[0]["start_time"] == "15:00"
    assert builder.build_activity(user_id, 2026) == ["2026-07-16"]


def test_the_streak_is_the_current_one_and_counts_local_days():
    today = builder.date(2026, 7, 20)
    days = {"2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13", "2026-07-18", "2026-07-19"}
    assert builder._streak_days(days, today) == 2              # yesterday and the day before
    assert builder._streak_days(days | {"2026-07-20"}, today) == 3
    assert builder._streak_days({"2026-07-17"}, today) == 0    # a missed day ends it
    assert builder._best_streak_days(days) == 4
