"""Workout Score: parts, grade, feedback and trend, all derived from rep analysis captures."""

from __future__ import annotations

import json

import pytest

from backend import config
from backend.reports import builder
from backend.reports.workout_score import (
    MIN_REPS,
    grade,
    rep_workout_score,
    timed_workout_score,
    trend,
)

TEMPLATES = {
    "knee_valgus": {"fault_label": "Knee valgus", "coaching": "Drive your knees out over your toes.",
                    "scoring": {"role": "penalty"}},
    "depth": {"fault_label": "Short depth", "coaching": "Sit until your hips reach knee height.",
              "full_rom_gate": 0.85, "scoring": {"role": "rom"}},
}


def rep(technique=100.0, rom=1.0, *, shallow=False, quality="reliable", time_s=2.0, valgus=0.0) -> dict:
    return {
        "final": round(technique * rom, 1), "technique": technique, "rom_factor": rom, "shallow": shallow,
        "quality": quality, "time_s": time_s,
        "penalties": {"knee_valgus": valgus, **({"depth": 1 - rom} if rom < 1 else {})},
    }


def by_rule(reps: list[dict]) -> list[dict]:
    return builder._by_rule(reps, TEMPLATES)


def score(reps: list[dict], planned: int | None = None) -> dict:
    return rep_workout_score(reps, planned_total=len(reps) if planned is None else planned,
                             by_rule=by_rule(reps), templates=TEMPLATES, rom_rule_id="depth")


# ---------------------------------------------------------------- scoring

@pytest.mark.parametrize("count", [0, MIN_REPS - 1])
def test_too_few_reps_gets_no_score_and_says_why(count):
    ws = score([rep()] * count, planned=10)
    assert ws["status"] == "not_enough_reps" and ws["score"] is None and ws["parts"] is None
    assert str(MIN_REPS) in ws["headline"]


def test_a_clean_full_set_is_excellent_with_nothing_to_fix():
    ws = score([rep() for _ in range(8)])
    assert ws["score"] == 100 and ws["grade"] == "Excellent" and ws["status"] == "scored"
    assert ws["focus"] is None and ws["headline"].startswith("Everything came together")
    assert ws["correct_pct"] == 100 and ws["avg_depth"] == 1.0
    assert [p["weight"] for p in ws["parts"]] == [40, 25, 20, 15]


def test_depth_is_counted_once_not_twice():
    # Shallow reps with perfect technique: technique stays 100, only the depth part drops.
    ws = score([rep(rom=0.6, shallow=True) for _ in range(6)])
    parts = {p["key"]: p["score"] for p in ws["parts"]}
    assert parts["technique"] == 100 and parts["depth"] == 60
    assert ws["focus"]["part"] == "depth"
    assert ws["focus"]["text"] == "6 of 6 reps came up short of full range."
    assert ws["focus"]["tip"] == TEMPLATES["depth"]["coaching"]


def test_technique_focus_names_the_most_costly_form_fault_and_its_fix():
    reps = [rep(technique=60, valgus=0.4) for _ in range(4)] + [rep() for _ in range(2)]
    ws = score(reps)
    assert ws["focus"]["part"] == "technique" and ws["focus"]["rule"] == "knee_valgus"
    assert ws["focus"]["text"] == "Knee valgus showed up on 4 of 6 reps."
    assert ws["focus"]["tip"] == TEMPLATES["knee_valgus"]["coaching"]


def test_technique_focus_never_names_the_depth_rule():
    reps = [rep(technique=60, rom=0.7, shallow=True) for _ in range(5)]  # depth is the only flagged rule
    ws = score(reps)
    assert ws["focus"]["part"] == "technique"
    assert "rule" not in ws["focus"]


def test_unfinished_sets_lower_completion_and_say_so():
    ws = score([rep() for _ in range(5)], planned=20)
    parts = {p["key"]: p["score"] for p in ws["parts"]}
    assert parts["completion"] == 25
    assert ws["focus"]["part"] == "completion" and ws["focus"]["text"] == "You finished 5 of 20 planned reps."


def test_fading_form_over_a_long_set_is_called_out():
    reps = [rep() for _ in range(4)] + [rep(technique=85) for _ in range(2)] + [rep(technique=40) for _ in range(3)]
    ws = score(reps)
    # technique is lowest here; consistency is still computed from the same reps
    assert {p["key"]: p["score"] for p in ws["parts"]}["consistency"] < 85
    from backend.reports.workout_score import _focus_text
    text = _focus_text("consistency", {"n": 9, "first": 100, "last": 40, "tempo": 100}, "rep", "reps", None, {}, None)
    assert text["text"] == "Form faded from 100 on your first reps to 40 on your last."


def test_uneven_tempo_is_the_consistency_focus_when_form_holds():
    reps = [rep(time_s=t) for t in (1.0, 4.0, 1.0, 4.0, 1.0, 4.0)]
    ws = score(reps)
    assert ws["focus"]["part"] == "consistency"
    assert ws["focus"]["text"] == "Your rep speed changed a lot from rep to rep."


def test_correct_reps_need_good_form_and_full_depth():
    reps = [rep(), rep(), rep(technique=70), rep(rom=0.9, shallow=True)]
    ws = score(reps)
    assert ws["correct_reps"] == 2 and ws["correct_pct"] == 50


def test_mostly_low_confidence_tracking_makes_the_score_provisional():
    ws = score([rep(quality="low_confidence") for _ in range(3)] + [rep()])
    assert ws["status"] == "provisional" and ws["tracking_note"]
    assert score([rep(quality="low_confidence")] + [rep() for _ in range(3)])["status"] == "scored"


def test_missing_parts_are_left_out_rather_than_counted_as_zero():
    reps = [{**rep(), "rom_factor": None} for _ in range(4)]
    ws = score(reps)
    assert {p["key"]: p["score"] for p in ws["parts"]}["depth"] is None
    assert ws["score"] == 100


def test_technique_is_recovered_exactly_from_older_captures():
    reps = [{**rep(technique=80, rom=0.5), "technique": None} for _ in range(3)]
    assert {p["key"]: p["score"] for p in score(reps)["parts"]}["technique"] == 80


@pytest.mark.parametrize("value,expected", [
    (100, "Excellent"), (90, "Excellent"), (89.9, "Strong"), (75, "Strong"),
    (60, "Solid"), (40, "Building"), (39, "Getting started"), (0, "Getting started"),
])
def test_grades(value, expected):
    assert grade(value) == expected


def test_trend_wording():
    assert trend(None, 70) is None
    assert trend(80, None)["delta"] is None
    assert trend(80, 74) == {"previous": 74, "delta": 6, "text": "Up 6 from last time."}
    assert trend(70, 74)["text"].startswith("Down 4 from last time")
    assert trend(74, 74)["delta"] == 0


# ---------------------------------------------------------------- timed

def _timed_set(status="complete", form=0.9, rom=0.95, lifts=10, full=9, shallow=1, balance="balanced", quality="reliable"):
    return {"status": status, "counted_lifts": lifts, "full_lifts": full, "shallow_lifts": shallow,
            "score": {"score": 100 * form * rom, "form_factor": form, "rom_factor": rom, "quality": quality},
            "monitors": {"left_right_asymmetry": {"status": balance}}}


def test_timed_exercise_is_scored_from_its_set_scores():
    ws = timed_workout_score([_timed_set(), _timed_set()], planned_sets=2)
    parts = {p["key"]: p["score"] for p in ws["parts"]}
    assert parts == {"technique": 90, "depth": 95, "completion": 100, "consistency": 100}
    assert ws["correct_pct"] == 90 and ws["grade"] == "Excellent"


def test_timed_imbalance_is_the_focus():
    ws = timed_workout_score([_timed_set(balance="asymmetric"), _timed_set()], planned_sets=2)
    assert ws["focus"]["part"] == "consistency"
    assert ws["focus"]["text"] == "One leg lifted lower than the other in 1 of 2 sets."


def test_timed_needs_enough_lifts():
    ws = timed_workout_score([_timed_set(lifts=2, full=2, shallow=0)], planned_sets=1)
    assert ws["score"] is None and ws["status"] == "not_enough_reps"


# ---------------------------------------------------------------- report integration

UID = "ana-tester-abc123"


def _write_session(root, sid: str, created: str, scores: list[tuple[float, float]]) -> None:
    session_dir = root / UID / "sessions" / sid
    set_dir = session_dir / "workouts" / "squat" / "set_1"
    set_dir.mkdir(parents=True)
    (session_dir / "session.json").write_text(json.dumps({
        "created_at": created, "session_id": sid, "user_id": UID, "skill_level": "beginner",
        "plan": {"exercise_id": "squat", "exercise_name": "Squat", "sets": 1,
                 "target": {"type": "reps", "value": len(scores)}, "metadata": {}},
    }))
    (set_dir / "set_summary.json").write_text(json.dumps({"completed_reps": len(scores)}))
    for n, (technique, rom) in enumerate(scores, 1):
        rep_dir = set_dir / f"rep_{n}"
        rep_dir.mkdir()
        attempt = {"qualified": True, "classification": "full_rom" if rom >= 1 else "shallow",
                   "peak": rom * 0.85, "score": technique * rom, "time_score": technique,
                   "rom_factor": rom, "quality": "reliable"}
        (rep_dir / "form_score.json").write_text(json.dumps({
            "final_score": technique * rom, "last_attempt": attempt, "last_rep": attempt,
            "phase_scores": {}, "movement_duration_ms": 2000.0}))
        (rep_dir / "metadata.json").write_text(json.dumps({"templates": TEMPLATES}))


@pytest.fixture
def two_sessions(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path)
    _write_session(tmp_path, "20260901T090000-aaaa", "2026-09-01T09:00:00+00:00", [(70, 1.0)] * 4)
    _write_session(tmp_path, "20260905T090000-bbbb", "2026-09-05T09:00:00+00:00", [(100, 1.0)] * 4)
    return tmp_path


def test_reports_carry_the_score_the_trend_and_the_contract_metrics(two_sessions):
    first = builder.build_exercise_report(UID, "20260901T090000-aaaa", "squat")
    second = builder.build_session_report(UID, "20260905T090000-bbbb")
    assert first["workout_score"]["trend"]["previous"] is None  # a later session is never "last time"
    ws = second["workout_score"]
    assert ws["score"] == 100 and ws["trend"]["previous"] == first["workout_score"]["score"]
    assert ws["trend"]["delta"] == 100 - first["workout_score"]["score"]
    assert second["activity_metrics"] == {"reps": 4, "good_reps": 4, "reps_not_counted": 0, "correct_pct": 100,
                                          "avg_depth": 1.0, "workout_score": 100}


def test_overview_and_progress_show_the_workout_score(two_sessions):
    overview = builder.build_overview(UID, "20260905T090000-bbbb")
    assert overview["workout_score"] == 100
    assert overview["exercises"][0]["workout_score"] == 100 and overview["exercises"][0]["workout_grade"] == "Excellent"
    progress = builder.build_progress(UID)
    assert [s["workout_score"] for s in progress["sessions"]] == [
        builder.build_overview(UID, "20260901T090000-aaaa")["workout_score"], 100]
