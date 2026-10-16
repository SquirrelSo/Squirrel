"""Build analytics report payloads from persisted session captures.

Everything here is READ-ONLY aggregation over files the training capture already wrote:
  data/users/{uid}/sessions/{sid}/session.json
  .../workouts/{exercise}/set_{n}/set_summary.json
  .../workouts/{exercise}/set_{n}/rep_{m}/form_score.json
  .../workouts/{exercise}/set_{n}/rep_{m}/metadata.json   (embeds template config + coaching)

No rep scoring is recomputed — form_score.json is authoritative. The Workout Score
(workout_score.py) is built on top of it. Output shapes match the frontend
contracts in frontend-react/src/flow/storage.ts (SessionReport, SessionOverview, ProgressData,
SessionListItem) exactly.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path

from backend.activity_rating.store import read_rating
from backend.config import user_dir
from backend.localtime import now_local, to_local
from backend.reports.workout_score import activity_metrics, rep_workout_score, timed_workout_score, trend
from backend.sessions.store import read_session_record

# Quality bands mirror the frontend (tokens.tsx formBand / charts.tsx scoreColor).
_GOOD_MIN = 80
_POOR_MAX = 50  # score < 50 -> poor; [50, 80) -> borderline; >= 80 -> good
# Form-score evidence is only ever recorded for movement phases, so the report keeps every phase
# except the two lifecycle phases. This stays exercise-agnostic: squat (descent/bottom/ascent) and
# curl (ascent/top/descent) both flow through unchanged.
_LIFECYCLE_PHASES = ("setup", "reset")
_SET_RE = re.compile(r"^set_(\d+)$")
_REP_RE = re.compile(r"^rep_(\d+)$")


# --------------------------------------------------------------------------- io

def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _numbered_dirs(parent: Path, pattern: re.Pattern[str]) -> list[tuple[int, Path]]:
    if not parent.is_dir():
        return []
    out: list[tuple[int, Path]] = []
    for child in parent.iterdir():
        match = pattern.match(child.name)
        if child.is_dir() and match:
            out.append((int(match.group(1)), child))
    return sorted(out, key=lambda item: item[0])


def _session_dir(uid: str, sid: str) -> Path:
    return user_dir(uid) / "sessions" / sid


# ----------------------------------------------------------------- date helpers

def _parse_created(created_at: str | None, time_zone: object = None) -> tuple[str, str, str]:
    """(date 'YYYY-MM-DD', day 'Mon', start_time 'HH:MM') of an ISO timestamp on the person's own
    clock: the session's time zone (backend/localtime.py), never UTC."""
    if not created_at:
        return "", "", ""
    try:
        dt = to_local(datetime.fromisoformat(created_at.replace("Z", "+00:00")), time_zone)
    except ValueError:
        return created_at[:10], "", ""
    return dt.strftime("%Y-%m-%d"), dt.strftime("%a"), dt.strftime("%H:%M")


def _round(value: float | None, digits: int = 1) -> float | None:
    return None if value is None else round(value, digits)


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _quality_bucket(score: float | None) -> str | None:
    if score is None:
        return None
    if score >= _GOOD_MIN:
        return "good"
    return "poor" if score < _POOR_MAX else "borderline"


# ------------------------------------------------------------- rep-level extract

def _rom_rule_id(form_score: dict) -> str | None:
    for phase_data in (form_score.get("phase_scores") or {}).values():
        for rule_id, rd in (phase_data.get("rules") or {}).items():
            if rd.get("role") == "rom":
                return rule_id
    return None


def _rep_penalties(form_score: dict) -> dict[str, float]:
    """Per-rule penalty for this rep. Penalty rules sum their weighted phase penalties; the ROM
    rule's penalty is the depth shortfall (1 - rom_factor) on shallow reps."""
    penalties: dict[str, float] = {}
    for phase, phase_data in (form_score.get("phase_scores") or {}).items():
        if phase in _LIFECYCLE_PHASES:
            continue
        for rule_id, rd in (phase_data.get("rules") or {}).items():
            if rd.get("role") == "penalty":
                penalties[rule_id] = penalties.get(rule_id, 0.0) + float(rd.get("weighted_penalty") or 0.0)
    last = form_score.get("last_rep") or form_score.get("last_attempt") or {}
    if last.get("classification") == "shallow":
        rom_factor = last.get("rom_factor")
        rom_id = _rom_rule_id(form_score)
        if rom_id is not None and isinstance(rom_factor, (int, float)):
            penalties[rom_id] = penalties.get(rom_id, 0.0) + max(0.0, 1.0 - float(rom_factor))
    return penalties


def _rep_rule_phase(form_score: dict) -> dict[str, dict[str, float]]:
    """rule -> phase -> phase form score (0..100, higher is better) for the movement phases.

    This is the heatmap source. Only penalty rules appear here: the ROM/depth rule is a per-rep
    peak with no phase breakdown (surfaced separately as the depth chip), so it is never a heatmap
    row. A phase where the rule collected no evidence — e.g. the bottom phase of a shallow rep that
    never reached depth — is omitted entirely so the cell reads "—" rather than a misleading 100.

    The frontend renders each cell as a form score where 100 = clean and lower = flagged for more
    of that phase, so convert the raw not_ok fraction (0 = clean, 1 = fully faulted) into that
    scale here: score = 100 * (1 - fraction)."""
    out: dict[str, dict[str, float]] = {}
    for phase, phase_data in (form_score.get("phase_scores") or {}).items():
        if phase in _LIFECYCLE_PHASES:
            continue
        for rule_id, rd in (phase_data.get("rules") or {}).items():
            if rd.get("role") != "penalty":
                continue
            raw = rd.get("not_ok_fraction")
            if raw is None:  # rule collected no evidence in this phase -> no score to show
                continue
            fraction = min(1.0, max(0.0, float(raw)))
            out.setdefault(rule_id, {})[phase] = round(100.0 * (1.0 - fraction))
    return out


def _collect_reps(workout_dir: Path) -> tuple[list[dict], dict[str, dict], dict[str, int]]:
    """Return (per-rep records, template config keyed by rule_id, attempts that did not count by
    reason) for one exercise. Only reps that counted toward the set are reps: an attempt the
    counting policy rejected (short of full range, too fast, under the minimum) is tallied by its
    reason instead, so the report shows it without paying for it."""
    reps: list[dict] = []
    templates: dict[str, dict] = {}
    not_counted = {"shallow": 0, "too_fast": 0, "other": 0}
    for set_no, set_dir in _numbered_dirs(workout_dir, _SET_RE):
        for rep_no, rep_dir in _numbered_dirs(set_dir, _REP_RE):
            fs = _read_json(rep_dir / "form_score.json")
            if fs is None:
                continue
            if not templates:
                meta = _read_json(rep_dir / "metadata.json") or {}
                templates = meta.get("templates") or {}
            # This attempt's own analysis (last_rep can belong to an earlier rep).
            attempt = fs.get("last_attempt") or fs.get("last_rep") or {}
            if attempt.get("qualified") is False:
                reason = attempt.get("reason")
                not_counted[reason if reason in ("shallow", "too_fast") else "other"] += 1
                continue
            last = attempt
            score = fs.get("final_score")
            peak = last.get("peak")
            rom = round(min(100.0, max(0.0, float(peak) * 100))) if isinstance(peak, (int, float)) else None
            reps.append({
                "rep": rep_no,
                "set": set_no,
                "score": _round(score, 1) if isinstance(score, (int, float)) else 0,
                "shallow": last.get("classification") == "shallow",
                "rom": rom,
                "time_s": _round(float(fs.get("movement_duration_ms") or 0.0) / 1000.0, 1),
                "rule_phase": _rep_rule_phase(fs),
                "penalties": _rep_penalties(fs),
                # Workout Score inputs: the rep score's two factors and its tracking quality.
                "final": _number(score),
                "technique": _number(attempt.get("time_score")),
                "rom_factor": _number(attempt.get("rom_factor")),
                "quality": attempt.get("quality"),
            })
    return reps, templates, not_counted


# ------------------------------------------------------------------- aggregation

def _issue_name(rule_id: str, templates: dict[str, dict]) -> str:
    label = (templates.get(rule_id) or {}).get("fault_label")
    if isinstance(label, str) and label.strip():
        return label
    return rule_id.replace("_", " ").capitalize()


def _by_rule(reps: list[dict], templates: dict[str, dict]) -> list[dict]:
    total_penalty = sum(sum(r["penalties"].values()) for r in reps) or 0.0
    rule_ids: list[str] = []
    for r in reps:
        for rid in r["penalties"]:
            if rid not in rule_ids:
                rule_ids.append(rid)
    rows: list[dict] = []
    for rid in rule_ids:
        rule_penalty = sum(r["penalties"].get(rid, 0.0) for r in reps)
        flagged = [r for r in reps if r["penalties"].get(rid, 0.0) > 0]
        scores = [max(0.0, 100.0 - r["penalties"].get(rid, 0.0) * 100.0) for r in reps]
        rows.append({
            "rule": rid,
            "issue_name": _issue_name(rid, templates),
            "penalty_share": round(rule_penalty / total_penalty, 3) if total_penalty else 0.0,
            "flagged_reps": len(flagged),
            "avg_score": round(sum(scores) / len(scores)) if scores else 0,
        })
    return sorted(rows, key=lambda x: (-x["penalty_share"], -x["flagged_reps"], x["rule"]))


def _rule_phase_avg(reps: list[dict]) -> dict[str, dict[str, float]]:
    acc: dict[str, dict[str, list[float]]] = {}
    for r in reps:
        for rid, phases in r["rule_phase"].items():
            for phase, frac in phases.items():
                acc.setdefault(rid, {}).setdefault(phase, []).append(frac)
    return {
        rid: {phase: round(sum(vals) / len(vals)) for phase, vals in phases.items()}
        for rid, phases in acc.items()
    }


def _coaching(reps: list[dict], templates: dict[str, dict], by_rule: list[dict]) -> list[dict]:
    out: list[dict] = []
    for row in by_rule:
        if row["flagged_reps"] == 0:
            continue
        rid = row["rule"]
        tmpl = templates.get(rid) or {}
        flagged_reps = sorted(r["rep"] for r in reps if r["penalties"].get(rid, 0.0) > 0)
        out.append({
            "rule": rid,
            "issue_name": row["issue_name"],
            "reps": flagged_reps,
            "fix": tmpl.get("coaching") or tmpl.get("cue") or "",
            "text": tmpl.get("issue") or "",
        })
        if len(out) == 2:
            break
    return out


def _report_insights(scores: list[float], reps: list[dict], planned_total: int) -> list[str]:
    out: list[str] = []
    if scores:
        avg = round(sum(scores) / len(scores))
        if avg >= 85:
            out.append(f"Strong session — {avg} average form. Keep this quality as you add load.")
        elif avg >= 65:
            out.append(f"Solid session — {avg} average form, with a few reps to tighten up.")
        else:
            out.append(f"Work on the basics — {avg} average form. Focus on one cue at a time.")
    shallow = sum(1 for r in reps if r["shallow"])
    if shallow:
        out.append(f"{shallow} rep{'s' if shallow != 1 else ''} came up short of depth.")
    if planned_total and len(reps) < planned_total:
        out.append(f"You completed {len(reps)} of {planned_total} planned reps.")
    return out


# ---------------------------------------------------------------- public builders

def _exercise_report(record: dict, uid: str, sid: str, exercise_id: str) -> dict:
    plan = record.get("plan") or {}
    workout_dir = _session_dir(uid, sid) / "workouts" / exercise_id
    target = plan.get("target") or {}
    if target.get("type") == "time":
        return _timed_exercise_report(record, sid, exercise_id, workout_dir)
    reps, templates, not_counted = _collect_reps(workout_dir)

    date, day, start_time = _parse_created(record.get("created_at"), record.get("timezone"))
    meta = plan.get("metadata") or {}
    measure = "reps"
    reps_per_set = int(target.get("value") or 0)
    planned_sets = int(plan.get("sets") or 0)

    set_dirs = _numbered_dirs(workout_dir, _SET_RE)
    per_set_full: list[dict] = []
    for set_no, set_dir in set_dirs:
        summary = _read_json(set_dir / "set_summary.json") or {}
        set_reps = [r for r in reps if r["set"] == set_no]
        set_by_rule = _by_rule(set_reps, templates)
        per_set_full.append({
            "set": set_no,
            "avg_score": round(summary.get("average_form_score") or 0),
            "reps": summary.get("completed_reps", len(set_reps)),
            "time_s": _round(float(summary.get("active_movement_ms") or 0.0) / 1000.0, 1),
            "by_rule": set_by_rule,
            "rule_phase": _rule_phase_avg(set_reps),
            "coaching": _coaching(set_reps, templates, set_by_rule),
        })

    depth_target: float | None = None
    for tmpl in templates.values():
        gate = tmpl.get("full_rom_gate")
        if isinstance(gate, (int, float)):
            depth_target = round(gate * 100)
            break

    scores = [r["score"] for r in reps if isinstance(r["score"], (int, float))]
    times = [r["time_s"] for r in reps if isinstance(r["time_s"], (int, float))]
    all_by_rule = _by_rule(reps, templates)
    rom_rule_id = next((rid for rid, t in templates.items() if (t.get("scoring") or {}).get("role") == "rom"), None)
    workout = rep_workout_score(reps, planned_total=planned_sets * reps_per_set, by_rule=all_by_rule,
                                templates=templates, rom_rule_id=rom_rule_id)

    return {
        "session_id": sid,
        "date": date, "day": day, "start_time": start_time,
        "skill_level": record.get("skill_level") or "",
        "exercise": plan.get("exercise_name") or exercise_id,
        "exercise_id": exercise_id,
        "measure": measure,
        "body_part": meta.get("body_part"),
        "training_tag": meta.get("training_tag"),
        "planned": {"sets": planned_sets, "reps_per_set": reps_per_set, "total": planned_sets * reps_per_set,
                    "weight_kg": plan.get("weight_kg")},
        "actual": {"reps_completed": len(reps), "sets_completed": len(set_dirs)},
        "depth_target": depth_target,
        "summary": {
            "avg_form_score": round(sum(scores) / len(scores), 1) if scores else None,
            "total_reps": len(reps),
            # Full-range reps; shallow ones that counted (exercises that allow them) are in
            # shallow_reps together with those that did not.
            "good_reps": sum(1 for r in reps if not r["shallow"]),
            "shallow_reps": sum(1 for r in reps if r["shallow"]) + not_counted["shallow"],
            "not_counted": not_counted,
            "best": round(max(scores)) if scores else None,
            "worst": round(min(scores)) if scores else None,
            "avg_rep_time_s": _round(sum(times) / len(times), 1) if times else None,
            "total_time_s": _round(sum(times), 1) if times else None,
        },
        "per_rep": [
            {"rep": r["rep"], "set": r["set"], "score": r["score"], "shallow": r["shallow"],
             "rom": r["rom"], "rule_phase": r["rule_phase"], "time_s": r["time_s"]}
            for r in reps
        ],
        "per_set": [
            {"set": s["set"], "avg_score": s["avg_score"], "reps": s["reps"], "time_s": s["time_s"]}
            for s in per_set_full
        ],
        "by_rule": all_by_rule,
        "rule_phase": _rule_phase_avg(reps),
        "coaching": _coaching(reps, templates, all_by_rule),
        "sets": [
            {"set": s["set"], "by_rule": s["by_rule"], "rule_phase": s["rule_phase"], "coaching": s["coaching"]}
            for s in per_set_full
        ],
        "insights": _report_insights(scores, reps, planned_sets * reps_per_set),
        "workout_score": workout,
    }


def _timed_exercise_report(
    record: dict,
    sid: str,
    exercise_id: str,
    workout_dir: Path,
) -> dict:
    """Build a duration report from set summaries without inventing rep artifacts."""
    plan = record.get("plan") or {}
    target = plan.get("target") or {}
    meta = plan.get("metadata") or {}
    date, day, start_time = _parse_created(record.get("created_at"), record.get("timezone"))
    planned_sets = int(plan.get("sets") or 0)
    target_ms = int(target.get("value_ms") or 0)
    summaries: list[tuple[int, dict]] = [
        (set_no, _read_json(set_dir / "set_summary.json") or {})
        for set_no, set_dir in _numbered_dirs(workout_dir, _SET_RE)
    ]
    complete = [(number, summary) for number, summary in summaries if summary.get("status") == "complete"]
    scores = [
        float(summary["average_form_score"])
        for _, summary in summaries
        if isinstance(summary.get("average_form_score"), (int, float))
        and not isinstance(summary.get("average_form_score"), bool)
    ]
    total_time_ms = sum(
        _timed_set_duration_ms(summary, target_ms)
        for _, summary in summaries
    )
    counted_lifts = sum(int(summary.get("counted_lifts") or 0) for _, summary in summaries)
    detected_cycles = sum(int(summary.get("detected_cycles") or 0) for _, summary in summaries)
    full_lifts = sum(int(summary.get("full_lifts") or 0) for _, summary in summaries)
    shallow_lifts = sum(int(summary.get("shallow_lifts") or 0) for _, summary in summaries)
    invalid_lifts = sum(int(summary.get("invalid_lifts") or 0) for _, summary in summaries)
    asymmetry_sets = sum(
        _timed_asymmetry(summary).get("status") == "asymmetric"
        for _, summary in summaries
    )
    per_set = [
        {
            "set": set_no,
            "avg_score": round(summary.get("average_form_score") or 0),
            "counted_lifts": int(summary.get("counted_lifts") or 0),
            "detected_cycles": int(summary.get("detected_cycles") or 0),
            "time_s": _round(
                _timed_set_duration_ms(summary, target_ms) / 1000.0,
                1,
            ),
            "left_right_asymmetry": _timed_asymmetry(summary) or None,
        }
        for set_no, summary in summaries
    ]
    insights: list[str] = []
    if scores:
        insights.append(f"Timed-set form averaged {round(sum(scores) / len(scores))}.")
    if len(complete) < planned_sets:
        insights.append(f"You completed {len(complete)} of {planned_sets} planned timed sets.")
    if asymmetry_sets:
        insights.append(
            f"Uneven left/right knee travel appeared in {asymmetry_sets} timed "
            f"set{'s' if asymmetry_sets != 1 else ''}."
        )
    workout = timed_workout_score([summary for _, summary in summaries], planned_sets=planned_sets)
    return {
        "session_id": sid,
        "date": date,
        "day": day,
        "start_time": start_time,
        "skill_level": record.get("skill_level") or "",
        "exercise": plan.get("exercise_name") or exercise_id,
        "exercise_id": exercise_id,
        "measure": "time",
        "body_part": meta.get("body_part"),
        "training_tag": meta.get("training_tag"),
        "planned": {
            "sets": planned_sets,
            "duration_seconds": target_ms / 1000.0,
            "total_duration_seconds": planned_sets * target_ms / 1000.0,
        },
        "actual": {
            "sets_completed": len(complete),
            "counted_lifts": counted_lifts,
            "detected_cycles": detected_cycles,
        },
        "summary": {
            "avg_form_score": round(sum(scores) / len(scores), 1) if scores else None,
            "total_time_s": _round(total_time_ms / 1000.0, 1),
            "counted_lifts": counted_lifts,
            "full_lifts": full_lifts,
            "shallow_lifts": shallow_lifts,
            "invalid_lifts": invalid_lifts,
            "asymmetry_sets": asymmetry_sets,
        },
        "per_set": per_set,
        "insights": insights,
        "workout_score": workout,
    }


def _timed_asymmetry(summary: dict) -> dict:
    monitors = summary.get("monitors")
    if not isinstance(monitors, dict):
        return {}
    value = monitors.get("left_right_asymmetry")
    return value if isinstance(value, dict) else {}


def _timed_set_duration_ms(summary: dict, planned_target_ms: int) -> float:
    """Return active timed-set duration without trusting a browser-derived timestamp span.

    A complete timed set can only close at its configured target, enforced by the timed runtime
    contract. For an incomplete capture, preserve the backend's elapsed value so partial diagnostic
    data is still represented honestly.
    """
    if summary.get("status") == "complete" and planned_target_ms > 0:
        return float(planned_target_ms)
    return float(summary.get("elapsed_ms") or summary.get("set_duration_ms") or 0.0)


def build_session_report(uid: str, sid: str) -> dict | None:
    """The single-exercise report for a session (P1 has one exercise per session)."""
    record = read_session_record(uid, sid)
    if record is None:
        return None
    exercise_id = (record.get("plan") or {}).get("exercise_id")
    if not exercise_id:
        return None
    return _with_trend(_exercise_report(record, uid, sid, exercise_id), uid, sid, record, exercise_id)


def build_exercise_report(uid: str, sid: str, exercise_id: str) -> dict | None:
    record = read_session_record(uid, sid)
    if record is None:
        return None
    if (record.get("plan") or {}).get("exercise_id") != exercise_id:
        return None
    return _with_trend(_exercise_report(record, uid, sid, exercise_id), uid, sid, record, exercise_id)


def _with_trend(report: dict, uid: str, sid: str, record: dict, exercise_id: str) -> dict:
    """Add the comparison with the last scored session of the same exercise, and the metrics object
    this exercise would write to the shared activity_sessions table."""
    workout = report["workout_score"]
    workout["trend"] = trend(workout["score"], _previous_score(uid, sid, record, exercise_id))
    report["activity_metrics"] = activity_metrics(report)
    # The member's own rating of the session, beside the system-generated score, never mixed in.
    report["activity_rating"] = read_rating(uid, sid)
    return report


def _previous_score(uid: str, sid: str, record: dict, exercise_id: str) -> int | None:
    """Workout Score of the most recent EARLIER session of this exercise that has one."""
    this_start = record.get("created_at") or ""
    earlier = [
        (other.get("created_at") or "", other_sid, other)
        for other_sid, other in _iter_session_records(uid)
        if other_sid != sid
        and (other.get("plan") or {}).get("exercise_id") == exercise_id
        and (other.get("created_at") or "") < this_start
    ]
    for _, other_sid, other in sorted(earlier, reverse=True):
        score = _exercise_report(other, uid, other_sid, exercise_id)["workout_score"]["score"]
        if score is not None:
            return score
    return None


def build_overview(uid: str, sid: str) -> dict | None:
    record = read_session_record(uid, sid)
    if record is None:
        return None
    plan = record.get("plan") or {}
    exercise_id = plan.get("exercise_id")
    report = _exercise_report(record, uid, sid, exercise_id) if exercise_id else None
    date, day, start_time = _parse_created(record.get("created_at"), record.get("timezone"))

    exercises: list[dict] = []
    session_scores: list[float] = []
    total_reps = 0
    total_time = 0.0
    if report is not None:
        if report["measure"] == "time":
            avg = report["summary"]["avg_form_score"]
            if avg is not None:
                session_scores.append(avg)
            total_time += report["summary"]["total_time_s"] or 0.0
            exercises.append({
                "exercise_id": report["exercise_id"],
                "name": report["exercise"],
                "body_part": report["body_part"],
                "training_tag": report["training_tag"],
                "measure": "time",
                "has_data": bool(report["per_set"]),
                "avg_form_score": avg,
                "planned": report["planned"],
                "actual": report["actual"],
                "workout_score": report["workout_score"]["score"],
                "workout_grade": report["workout_score"]["grade"],
            })
            return {
                "session_id": sid, "date": date, "day": day, "start_time": start_time,
                "skill_level": record.get("skill_level") or "",
                "session_score": round(sum(session_scores) / len(session_scores)) if session_scores else None,
                "total_reps": 0,
                "total_time_s": _round(total_time, 1) if total_time else None,
                "exercise_count": len(exercises),
                "exercises": exercises,
                "workout_score": _session_workout_score(exercises),
                "activity_rating": read_rating(uid, sid),
            }
        quality = {"good": 0, "borderline": 0, "poor": 0}
        for r in report["per_rep"]:
            bucket = _quality_bucket(r["score"])
            if bucket:
                quality[bucket] += 1
        avg = report["summary"]["avg_form_score"]
        if avg is not None:
            session_scores.append(avg)
        total_reps += report["summary"]["total_reps"]
        total_time += report["summary"]["total_time_s"] or 0.0
        not_counted_total = sum((report["summary"].get("not_counted") or {}).values())
        exercises.append({
            "exercise_id": report["exercise_id"],
            "name": report["exercise"],
            "body_part": report["body_part"],
            "training_tag": report["training_tag"],
            "measure": report["measure"],
            # Trained, even if no rep counted: a set of only rejected attempts is still shown.
            "has_data": report["summary"]["total_reps"] + not_counted_total > 0,
            "avg_form_score": avg,
            "planned": {"sets": report["planned"]["sets"], "reps_per_set": report["planned"]["reps_per_set"],
                        "total": report["planned"]["total"], "weight_kg": report["planned"].get("weight_kg")},
            "actual": report["actual"],
            "plan_met": report["actual"]["reps_completed"] >= report["planned"]["total"],
            "shallow_reps": report["summary"]["shallow_reps"],
            "reps_not_counted": not_counted_total,
            "quality": quality,
            "workout_score": report["workout_score"]["score"],
            "workout_grade": report["workout_score"]["grade"],
        })

    return {
        "session_id": sid, "date": date, "day": day, "start_time": start_time,
        "skill_level": record.get("skill_level") or "",
        "session_score": round(sum(session_scores) / len(session_scores)) if session_scores else None,
        "total_reps": total_reps,
        "total_time_s": _round(total_time, 1) if total_time else None,
        "exercise_count": len(exercises),
        "exercises": exercises,
        "workout_score": _session_workout_score(exercises),
        "activity_rating": read_rating(uid, sid),
    }


def _session_workout_score(exercises: list[dict]) -> int | None:
    scores = [e["workout_score"] for e in exercises if e.get("workout_score") is not None]
    return round(sum(scores) / len(scores)) if scores else None


# ---------------------------------------------------------- cross-session builders

def _iter_session_records(uid: str) -> list[tuple[str, dict]]:
    sessions_dir = user_dir(uid) / "sessions"
    if not sessions_dir.is_dir():
        return []
    out: list[tuple[str, dict]] = []
    for child in sorted(sessions_dir.iterdir()):
        if not child.is_dir():
            continue
        record = _read_json(child / "session.json")
        if record is not None:
            out.append((child.name, record))
    return out


def list_sessions(uid: str) -> list[dict]:
    out: list[dict] = []
    for sid, record in _iter_session_records(uid):
        overview = build_overview(uid, sid)
        if overview is None:
            continue
        plan = record.get("plan") or {}
        date, day, start_time = _parse_created(record.get("created_at"), record.get("timezone"))
        out.append({
            "session_id": sid, "date": date, "day": day, "start_time": start_time,
            "exercise": plan.get("exercise_name") or plan.get("exercise_id") or "",
            "reps_completed": overview["total_reps"],
        })
    out.sort(key=lambda s: (s["date"], s["start_time"]), reverse=True)
    return out


def build_activity(uid: str, year: int) -> list[str]:
    dates: set[str] = set()
    for _sid, record in _iter_session_records(uid):
        date, _day, _start = _parse_created(record.get("created_at"), record.get("timezone"))
        if date.startswith(f"{year:04d}-"):
            dates.add(date)
    return sorted(dates)


def build_progress(uid: str) -> dict:
    sessions: list[dict] = []
    for sid, record in _iter_session_records(uid):
        overview = build_overview(uid, sid)
        if overview is None:
            continue
        date, day, start_time = _parse_created(record.get("created_at"), record.get("timezone"))
        sessions.append({
            "session_id": sid, "date": date, "day": day, "start_time": start_time,
            "score": overview["session_score"], "reps": overview["total_reps"],
            "workout_score": overview["workout_score"],
            "activity_rating": (overview["activity_rating"] or {}).get("rating"),
            "exercises": [e["name"] for e in overview["exercises"]] or [None],
            "_time": overview["total_time_s"] or 0.0,
            "_zone": record.get("timezone"),
        })
    sessions.sort(key=lambda s: (s["date"], s["start_time"]))  # oldest -> newest

    scored = [s for s in sessions if s["score"] is not None]
    avg_form = round(sum(s["score"] for s in scored) / len(scored)) if scored else None
    latest_score = scored[-1]["score"] if scored else None
    delta = (scored[-1]["score"] - scored[-2]["score"]) if len(scored) >= 2 else None
    best = None
    if scored:
        top = max(scored, key=lambda s: s["score"])
        best = {"score": top["score"], "date": top["date"], "session_id": top["session_id"]}
    total_time = sum(s["_time"] for s in sessions)
    # "Today" on the person's clock: the zone of their latest session (their phone's).
    today = now_local(sessions[-1]["_zone"] if sessions else None).date()

    return {
        "sessions": [{k: v for k, v in s.items() if not k.startswith("_")} for s in sessions],
        "totals": {"sessions": len(sessions), "reps": sum(s["reps"] for s in sessions),
                   "with_data": len(scored)},
        "avg_form": avg_form,
        "latest_score": latest_score,
        "delta": delta,
        "best": best,
        "streak_days": _streak_days({s["date"] for s in sessions}, today),
        "best_streak_days": _best_streak_days({s["date"] for s in sessions}),
        "this_week": _sessions_this_week(sessions, today),
        "total_time_s": round(total_time, 1) if total_time else None,
        "insights": _progress_insights(scored, len(sessions)),
    }


def _sessions_this_week(sessions: list[dict], today: date) -> int:
    """Sessions in today's Monday-to-Sunday week, by their local dates."""
    iso_year, iso_week, _ = today.isocalendar()
    count = 0
    for s in sessions:
        try:
            day = datetime.strptime(s["date"], "%Y-%m-%d").date()
        except ValueError:
            continue
        y, w, _ = day.isocalendar()
        if (y, w) == (iso_year, iso_week):
            count += 1
    return count


def _dates(values: set[str]) -> list[date]:
    return sorted({datetime.strptime(d, "%Y-%m-%d").date() for d in values if d})


def _streak_days(dates: set[str], today: date) -> int:
    """The current streak: consecutive training days ending today, or yesterday (today's workout
    may still be ahead). A missed day ends it."""
    days = set(_dates(dates))
    cursor = today if today in days else today - timedelta(days=1)
    streak = 0
    while cursor in days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def _best_streak_days(dates: set[str]) -> int:
    """The longest run of consecutive training days ever."""
    parsed = _dates(dates)
    if not parsed:
        return 0
    streak = best = 1
    for prev, cur in zip(parsed, parsed[1:]):
        streak = streak + 1 if (cur - prev).days == 1 else 1
        best = max(best, streak)
    return best


def _progress_insights(scored: list[dict], total: int) -> list[str]:
    out: list[str] = []
    if not total:
        return out
    out.append(f"{total} session{'s' if total != 1 else ''} logged.")
    if len(scored) >= 2:
        d = scored[-1]["score"] - scored[-2]["score"]
        if d > 0:
            out.append(f"Latest form up {d} points from your previous session.")
        elif d < 0:
            out.append(f"Latest form down {abs(d)} points — worth a lighter, cleaner session.")
    return out
