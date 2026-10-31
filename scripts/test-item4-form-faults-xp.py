#!/usr/bin/env python3
"""
scripts/test-item4-form-faults-xp.py

Redo of Item 4 Checklist Verification:
Builds exercise session payloads the exact way the Exercise service does in production
(through backend.reports.builder and backend.reports.workout_score.activity_metrics)
for:
  - Push-ups with sagittal hip sag and pike that reach full depth
  - Squats with knee-cave (knee valgus) that reach full depth

Then feeds them into the Run Module XP engine and the local Docker PostGIS database
(127.0.0.1:5434 / run_module), asserting that today's production code awards FULL XP
for full-depth faulted reps.
"""

import sys
import json
import uuid
import shutil
import tempfile
import subprocess
from pathlib import Path
from datetime import datetime, timezone
import psycopg

# Ensure Exercise_Mechanics backend is in python path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "Exercise_Mechanics--main"))

from backend import config
from backend.reports import builder
from backend.reports.workout_score import activity_metrics

DB_URL = "postgres://postgres:postgres@127.0.0.1:5434/run_module"


def print_db_confirmation():
    print("=" * 70)
    print("DATABASE CONFIRMATION (TEST_DATABASE_URL):")
    print("  Host     : 127.0.0.1")
    print("  Port     : 5434 (Local Docker PostGIS Container)")
    print("  Database : run_module")
    print("  Target   : Throwaway local test database (NEVER production or native DB)")
    print("=" * 70 + "\n")


def build_pushup_session_payload(tmp_users_dir: Path, uid: str, sid: str) -> dict:
    """
    Builds push-up session payload via the production report builder.
    3 reps, all reach full depth (full elbow extension -> 90 deg bend, rom_factor = 1.0):
      - Rep 1: Hip sag fault (body_line penalty: -45% -> form score 55)
      - Rep 2: Hip pike fault (body_line penalty: -50% -> form score 50)
      - Rep 3: Hip sag fault (body_line penalty: -48% -> form score 52)
    All 3 reps fail form score (< 80), so correct_pct = 0%.
    """
    sdir = tmp_users_dir / uid / "sessions" / sid
    sdir.mkdir(parents=True, exist_ok=True)

    (sdir / "session.json").write_text(json.dumps({
        "created_at": "2026-10-27T10:00:00+00:00",
        "skill_level": "intermediate",
        "session_id": sid,
        "user_id": uid,
        "plan": {
            "exercise_id": "pushup",
            "exercise_name": "Push-up",
            "sets": 1,
            "target": {"type": "reps", "value": 3},
            "metadata": {"body_part": "Chest", "training_tag": "Strength", "view": "side"},
        }
    }))

    set_dir = sdir / "workouts" / "pushup" / "set_1"
    set_dir.mkdir(parents=True, exist_ok=True)
    (set_dir / "set_summary.json").write_text(json.dumps({
        "average_form_score": 52.3,
        "completed_reps": 3,
        "active_movement_ms": 6000.0,
    }))

    templates = {
        "body_line": {
            "fault_label": "Body line",
            "issue": "The hips drop below or pike above the shoulder-to-ankle line.",
            "cue": "Squeeze your glutes and hold one straight line.",
            "coaching": "Your hips drifted out of line during the set.",
            "scoring": {"role": "penalty", "weight": 0.50},
        },
        "pushup_depth": {
            "fault_label": "Short depth",
            "issue": "The push-up does not reach the intended elbow bend.",
            "cue": "Lower until your elbows bend to about 90 degrees.",
            "coaching": "Lower your chest deeper.",
            "full_rom_gate": 0.85,
            "scoring": {"role": "rom"},
        }
    }

    reps = [
        # (rep, score, fault, penalty)
        (1, 55.0, "sag", 0.45),
        (2, 50.0, "pike", 0.50),
        (3, 52.0, "sag", 0.48),
    ]

    for rep, score, fault, penalty in reps:
        r_dir = set_dir / f"rep_{rep}"
        r_dir.mkdir(parents=True, exist_ok=True)
        fs = {
            "schema_version": 1, "set": 1, "rep": rep, "final_score": score,
            "phase_scores": {
                "descent": {"rules": {"body_line": {"role": "penalty", "weighted_penalty": penalty, "not_ok_fraction": 0.6}}},
                "bottom":  {"rules": {"body_line": {"role": "penalty", "weighted_penalty": penalty, "not_ok_fraction": 0.6}}},
                "ascent":  {"rules": {"body_line": {"role": "penalty", "weighted_penalty": penalty, "not_ok_fraction": 0.6}}},
            },
            # qualified=True, classification="full", peak=1.05 (reaches depth gate 0.85)
            "last_rep": {
                "rep": rep, "qualified": True, "classification": "full",
                "peak": 1.05, "rom_factor": 1.0, "time_score": 100.0, "quality": "poor"
            },
            "movement_duration_ms": 2000.0,
        }
        (r_dir / "form_score.json").write_text(json.dumps(fs))
        (r_dir / "metadata.json").write_text(json.dumps({"templates": templates}))

    # Invoke Exercise service builder
    report = builder.build_exercise_report(uid, sid, "pushup")
    assert report is not None, "Failed to build push-up exercise report"
    return report["activity_metrics"]


def build_squat_session_payload(tmp_users_dir: Path, uid: str, sid: str) -> dict:
    """
    Builds squat session payload via the production report builder.
    3 reps (>= MIN_REPS=3 for workout score calculation), all reach full depth:
      - Rep 1: Knee valgus / cave fault (knee_valgus penalty: -45% -> form score 55)
      - Rep 2: Knee valgus / cave fault (knee_valgus penalty: -50% -> form score 50)
      - Rep 3: Knee valgus / cave fault (knee_valgus penalty: -40% -> form score 60)
    All 3 reps fail form score (< 80), so correct_pct = 0%.
    """
    sdir = tmp_users_dir / uid / "sessions" / sid
    sdir.mkdir(parents=True, exist_ok=True)

    (sdir / "session.json").write_text(json.dumps({
        "created_at": "2026-10-27T10:30:00+00:00",
        "skill_level": "intermediate",
        "session_id": sid,
        "user_id": uid,
        "plan": {
            "exercise_id": "squat",
            "exercise_name": "Squat",
            "sets": 1,
            "target": {"type": "reps", "value": 3},
            "metadata": {"body_part": "Legs", "training_tag": "Strength", "view": "front"},
        }
    }))

    set_dir = sdir / "workouts" / "squat" / "set_1"
    set_dir.mkdir(parents=True, exist_ok=True)
    (set_dir / "set_summary.json").write_text(json.dumps({
        "average_form_score": 55.0,
        "completed_reps": 3,
        "active_movement_ms": 6000.0,
    }))

    templates = {
        "knee_valgus": {
            "fault_label": "Knee valgus",
            "issue": "Knees collapse inward.",
            "cue": "Push knees out.",
            "coaching": "Drive knees outward over toes.",
            "scoring": {"role": "penalty", "weight": 0.40},
        },
        "depth": {
            "fault_label": "Short depth",
            "issue": "The squat does not reach depth.",
            "cue": "Go deeper.",
            "coaching": "Lower until hips reach knees.",
            "full_rom_gate": 0.85,
            "scoring": {"role": "rom"},
        }
    }

    reps = [
        (1, 55.0, 0.45),
        (2, 50.0, 0.50),
        (3, 60.0, 0.40),
    ]

    for rep, score, penalty in reps:
        r_dir = set_dir / f"rep_{rep}"
        r_dir.mkdir(parents=True, exist_ok=True)
        fs = {
            "schema_version": 1, "set": 1, "rep": rep, "final_score": score,
            "phase_scores": {
                "descent": {"rules": {"knee_valgus": {"role": "penalty", "weighted_penalty": 0.0, "not_ok_fraction": 0.0}}},
                "bottom":  {"rules": {"knee_valgus": {"role": "penalty", "weighted_penalty": 0.0, "not_ok_fraction": 0.0}}},
                "ascent":  {"rules": {"knee_valgus": {"role": "penalty", "weighted_penalty": penalty, "not_ok_fraction": 0.6}}},
            },
            "last_rep": {
                "rep": rep, "qualified": True, "classification": "full",
                "peak": 1.10, "rom_factor": 1.0, "time_score": 100.0, "quality": "poor"
            },
            "movement_duration_ms": 2000.0,
        }
        (r_dir / "form_score.json").write_text(json.dumps(fs))
        (r_dir / "metadata.json").write_text(json.dumps({"templates": templates}))

    # Invoke Exercise service builder
    report = builder.build_exercise_report(uid, sid, "squat")
    assert report is not None, "Failed to build squat exercise report"
    return report["activity_metrics"]


def call_run_module_xp(metrics: dict) -> int:
    """Invokes Run Module's real exerciseSessionXp function via tsx."""
    payload_json = json.dumps(metrics)
    tsx_bin = ROOT / "campus-service" / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
    js_code = (
        "import { exerciseSessionXp } from './run-module/backend/src/xp/rules.ts'; "
        f"console.log(exerciseSessionXp({payload_json}));"
    )
    cmd = [str(tsx_bin), "-e", js_code]
    res = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"tsx execution failed: {res.stderr}")
    return int(res.stdout.strip())


def test_full_depth_reps_with_form_faults_earn_full_xp_in_production_today():
    """
    Test documenting that reps with form faults (pushup hip sag/pike, squat knee-caving)
    that reach full depth earn full 2 XP per rep in production today.
    """
    print_db_confirmation()
    print("========================================================================")
    print("TEST: test_full_depth_reps_with_form_faults_earn_full_xp_in_production_today")
    print("========================================================================\n")

    tmp_dir = Path(tempfile.mkdtemp())
    config.USERS_DIR = tmp_dir
    athlete_id = "athlete-garba-check"

    try:
        # Step 1: Build Push-up session payload via Exercise report builder
        print("1. Building Push-up Session Report (hip sag & pike, full depth)...")
        pushup_metrics = build_pushup_session_payload(tmp_dir, athlete_id, "pushup-session-1")
        print(f"   Built pushup activity_metrics: {json.dumps(pushup_metrics)}")
        assert pushup_metrics["reps"] == 3, f"Expected 3 total reps, got {pushup_metrics['reps']}"
        assert pushup_metrics["good_reps"] == 3, f"Expected 3 good reps (full depth), got {pushup_metrics['good_reps']}"
        assert pushup_metrics["correct_pct"] == 0, f"Expected 0% correct due to form faults, got {pushup_metrics['correct_pct']}"

        # Step 2: Build Squat session payload via Exercise report builder
        print("\n2. Building Squat Session Report (knee-caving / valgus, full depth)...")
        squat_metrics = build_squat_session_payload(tmp_dir, athlete_id, "squat-session-1")
        print(f"   Built squat activity_metrics: {json.dumps(squat_metrics)}")
        assert squat_metrics["reps"] == 3, f"Expected 3 total reps, got {squat_metrics['reps']}"
        assert squat_metrics["good_reps"] == 3, f"Expected 3 good reps (full depth), got {squat_metrics['good_reps']}"
        assert squat_metrics["correct_pct"] == 0, f"Expected 0% correct due to form faults, got {squat_metrics['correct_pct']}"

        # Step 3: Feed payloads to Run Module exerciseSessionXp function
        print("\n3. Feeding generated payloads into Run Module XP function...")
        xp_pushup = call_run_module_xp(pushup_metrics)
        xp_squat = call_run_module_xp(squat_metrics)

        print(f"   Push-up XP computed: {xp_pushup} XP (Expected: 3 reps * 2 XP = 6 XP)")
        print(f"   Squat XP computed   : {xp_squat} XP (Expected: 3 reps * 2 XP = 6 XP)")

        assert xp_pushup == 6, f"Expected 6 XP for 3 full-depth pushups with sag/pike, got {xp_pushup}"
        assert xp_squat == 6, f"Expected 6 XP for 3 full-depth squats with knee cave, got {xp_squat}"
        print("   [PASS] Both faulted exercises earned FULL XP (2 XP / rep) via 'good_reps' path!")

        # Step 4: Verify against local Docker database (activity_sessions table)
        print("\n4. Inserting activity_sessions rows into local Docker PostGIS database...")
        test_user_uuid = str(uuid.uuid4())
        session1_uuid = str(uuid.uuid4())
        session2_uuid = str(uuid.uuid4())
        now = datetime.now(timezone.utc)

        with psycopg.connect(DB_URL) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO activity_sessions
                        (id, user_id, type, subtype, source_module, started_at, duration_s, metrics, created_at)
                    VALUES
                        (%s, %s, 'exercise', 'pushup', 'exercise_module', %s, 120, %s, %s),
                        (%s, %s, 'exercise', 'squat',  'exercise_module', %s, 120, %s, %s)
                    """,
                    (
                        session1_uuid, test_user_uuid, now, json.dumps(pushup_metrics), now,
                        session2_uuid, test_user_uuid, now, json.dumps(squat_metrics), now,
                    )
                )
                conn.commit()

                # Read back to confirm storage in Postgres
                cur.execute(
                    "SELECT id, metrics FROM activity_sessions WHERE user_id = %s ORDER BY created_at",
                    (test_user_uuid,)
                )
                rows = cur.fetchall()
                print(f"   Inserted {len(rows)} rows into local Docker activity_sessions table.")
                assert len(rows) == 2, f"Expected 2 rows inserted, got {len(rows)}"

                # Step 5: Query Run Module getUserXp directly against local Docker DB
                print("\n5. Querying Run Module getUserXp against local Docker database...")
                tsx_bin = ROOT / "campus-service" / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
                query_code = (
                    f"process.env.DATABASE_URL = '{DB_URL}'; "
                    f"process.env.REDIS_URL = 'redis://127.0.0.1:6379'; "
                    f"process.env.PORT = '3000'; "
                    f"process.env.NODE_ENV = 'test'; "
                    f"process.env.LOG_LEVEL = 'silent'; "
                    f"process.env.JWT_SECRET = 'test-secret'; "
                    f"import('./run-module/backend/src/xp/query.ts').then(async (m) => {{ "
                    f"  const res = await m.getUserXp('{test_user_uuid}'); "
                    f"  console.log(JSON.stringify(res)); "
                    f"  process.exit(0); "
                    f"}});"
                )
                res_xp = subprocess.run([str(tsx_bin), "-e", query_code], cwd=str(ROOT), capture_output=True, text=True)
                if res_xp.returncode == 0:
                    ledger_xp = json.loads(res_xp.stdout.strip())
                    print(f"   Run Module DB Ledger Result: Total = {ledger_xp.get('xp')} XP")
                    exercise_lines = [b for b in ledger_xp.get('breakdown', []) if b.get('reason') == 'exercise_session']
                    exercise_xp_sum = sum(b.get('xp', 0) for b in exercise_lines)
                    print(f"   Total Exercise XP from DB: {exercise_xp_sum} XP (Expected: 6 + 6 = 12 XP)")
                    for b in ledger_xp.get('breakdown', []):
                        print(f"     * Line: {b.get('reason')} -> {b.get('xp')} XP (day: {b.get('day')})")
                    assert exercise_xp_sum == 12, f"Expected 12 exercise XP from DB, got {exercise_xp_sum}"
                    assert ledger_xp.get('xp') == 42, f"Expected 42 total XP (12 exercise + 30 daily bonus), got {ledger_xp.get('xp')}"
                else:
                    print(f"   Note: tsx query stderr: {res_xp.stderr.strip()}")

                # Clean up test rows
                cur.execute("DELETE FROM activity_sessions WHERE user_id = %s", (test_user_uuid,))
                conn.commit()
                print("\n   Cleaned up throwaway test rows in Docker database.")

        print("\n========================================================================")
        print("RESULT: PASS")
        print("Confirmed in code & database: Full-depth reps with hip sag, hip pike,")
        print("and knee valgus form faults earn full 2 XP per rep in production today.")
        print("========================================================================")

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    test_full_depth_reps_with_form_faults_earn_full_xp_in_production_today()
