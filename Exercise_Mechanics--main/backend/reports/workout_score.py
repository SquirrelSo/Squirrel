"""Workout Score: one 0–100 number per exercise in a session, with feedback, built only from what
pose detection and rep analysis captured. It is SYSTEM-GENERATED: nothing is asked of the user, no
profile data is used, and the member's own Activity Rating (backend/activity_rating/) never feeds it.

Every rep's form score is already technique × depth (engine/scorer.py: time_score × rom_factor).
The Workout Score keeps those two apart so depth is not counted twice and the feedback can say
which one cost the points:

    technique    40%  mean technique score: 100 minus the penalties from flagged faults
    depth        25%  mean depth reached, relative to the exercise's full-range gate
    completion   20%  reps done of reps planned
    consistency  15%  how steady form and tempo stayed from the first rep to the last

Timed exercises (high knees) use the same four parts from their set scores: form factor, lift
height, sets completed, and left/right balance.

A score needs at least MIN_REPS scored reps. If most reps were scored with incomplete tracking
the score is marked provisional: the report's own warning that a form percentage from a pose model
is only as fair as the camera view it came from.
"""

from __future__ import annotations

from statistics import mean, pstdev

WEIGHTS = {"technique": 0.40, "depth": 0.25, "completion": 0.20, "consistency": 0.15}
MIN_REPS = 3
CORRECT_MIN_SCORE = 80   # the "good" band the report UI already uses
STRENGTH_MIN = 85        # a part at or above this is praised
FOCUS_BELOW = 85         # a part below this can be the focus
FATIGUE_DROP = 8         # points lost between the first and last third of reps that counts as fading
FATIGUE_MIN_REPS = 6     # fewer reps than this and first-vs-last is noise, not fatigue
PROVISIONAL_SHARE = 0.5  # more than this share of low-confidence reps makes the score provisional

GRADES = ((90, "Excellent"), (75, "Strong"), (60, "Solid"), (40, "Building"), (0, "Getting started"))

LABELS = {"technique": "Technique", "depth": "Depth", "completion": "Completion", "consistency": "Consistency"}


def grade(score: float) -> str:
    return next(label for floor, label in GRADES if score >= floor)


def _clamp(value: float) -> float:
    return max(0.0, min(100.0, value))


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


# ---------------------------------------------------------------- rep-counted exercises

def rep_workout_score(reps: list[dict], *, planned_total: int, by_rule: list[dict],
                      templates: dict[str, dict], rom_rule_id: str | None) -> dict:
    """Score a rep-counted exercise from its per-rep analysis records.

    Each rep record needs: final (float|None), technique (float|None), rom_factor (float|None),
    shallow (bool), quality (str|None), time_s (float|None) and penalties ({rule: float})."""
    scored = [r for r in reps if r.get("final") is not None]
    n = len(scored)
    base = {
        "status": "not_enough_reps", "score": None, "grade": None, "parts": None,
        "correct_reps": 0, "correct_pct": None, "avg_depth": None,
        "scored_reps": n, "min_reps": MIN_REPS,
        "headline": None, "strengths": [], "focus": None,
    }
    if n < MIN_REPS:
        base["headline"] = (f"Complete at least {MIN_REPS} tracked reps to get a Workout Score."
                            if n == 0 else
                            f"Only {_plural(n, 'rep')} tracked — {MIN_REPS} are needed for a Workout Score.")
        return base

    finals = [r["final"] for r in scored]
    techniques = [_technique(r) for r in scored]
    depths = [r["rom_factor"] for r in scored if r.get("rom_factor") is not None]
    durations = [r["time_s"] for r in scored if r.get("time_s")]

    form_steadiness = _clamp(100 - 2.5 * pstdev(finals))
    tempo_steadiness = None
    if len(durations) >= MIN_REPS and mean(durations) > 0:
        tempo_steadiness = _clamp(100 * (1 - 2 * pstdev(durations) / mean(durations)))
    consistency = form_steadiness if tempo_steadiness is None else (form_steadiness + tempo_steadiness) / 2

    parts = {
        "technique": _clamp(mean(techniques)),
        "depth": _clamp(100 * mean(depths)) if depths else None,
        "completion": _clamp(100 * len(reps) / planned_total) if planned_total > 0 else None,
        "consistency": consistency,
    }
    score = _combine(parts)

    correct = sum(1 for r in scored if r["final"] >= CORRECT_MIN_SCORE and not r.get("shallow"))
    shallow = sum(1 for r in scored if r.get("shallow"))
    low_confidence = sum(1 for r in scored if r.get("quality") == "low_confidence")
    third = max(1, n // 3)
    first, last = mean(finals[:third]), mean(finals[-third:])

    facts = {
        "n": n, "done": len(reps), "planned": planned_total, "shallow": shallow,
        "first": round(first), "last": round(last), "tempo": tempo_steadiness,
        "faulty": sum(1 for r in scored
                      if any(p > 0 for rule, p in (r.get("penalties") or {}).items() if rule != rom_rule_id)),
    }
    # Technique feedback names a form fault, never the depth rule (depth has its own part).
    top_fault = next((row for row in by_rule if row.get("flagged_reps") and row.get("rule") != rom_rule_id), None)
    feedback = _feedback(parts, facts, top_fault, templates, rom_rule_id, kind="reps")

    return {
        **base,
        "status": "provisional" if low_confidence > PROVISIONAL_SHARE * n else "scored",
        "score": round(score),
        "grade": grade(score),
        "parts": _parts_view(parts),
        "correct_reps": correct,
        "correct_pct": round(100 * correct / n),
        "avg_depth": round(mean(depths), 2) if depths else None,
        **feedback,
        "tracking_note": ("Some joints were hard to see on most reps, so treat this score as a "
                          "rough guide. A clearer camera view will make it exact.")
        if low_confidence > PROVISIONAL_SHARE * n else None,
    }


def _technique(rep: dict) -> float:
    """The rep's technique score. Captures without a stored technique score recover it exactly
    from the rep score, which is technique × depth factor."""
    if rep.get("technique") is not None:
        return rep["technique"]
    if rep.get("rom_factor"):
        return min(100.0, rep["final"] / rep["rom_factor"])
    return rep["final"]


# ---------------------------------------------------------------- timed exercises

def timed_workout_score(summaries: list[dict], *, planned_sets: int) -> dict:
    """Score a timed exercise from its set summaries (rom_factor and form_factor per set)."""
    counted = sum(int(s.get("counted_lifts") or 0) for s in summaries)
    full = sum(int(s.get("full_lifts") or 0) for s in summaries)
    shallow = sum(int(s.get("shallow_lifts") or 0) for s in summaries)
    base = {
        "status": "not_enough_reps", "score": None, "grade": None, "parts": None,
        "correct_reps": full, "correct_pct": None, "avg_depth": None,
        "scored_reps": counted, "min_reps": MIN_REPS,
        "headline": None, "strengths": [], "focus": None,
    }
    set_scores = [s.get("score") for s in summaries if isinstance(s.get("score"), dict)]
    forms = [v for v in (_number(sc.get("form_factor")) for sc in set_scores) if v is not None]
    roms = [v for v in (_number(sc.get("rom_factor")) for sc in set_scores) if v is not None]
    if counted < MIN_REPS or not forms:
        base["headline"] = f"Complete at least {MIN_REPS} counted lifts to get a Workout Score."
        return base

    judged = [s for s in summaries if isinstance((s.get("monitors") or {}).get("left_right_asymmetry"), dict)
              and s["monitors"]["left_right_asymmetry"].get("status") in ("balanced", "asymmetric")]
    uneven = sum(1 for s in judged if s["monitors"]["left_right_asymmetry"]["status"] == "asymmetric")
    complete = sum(1 for s in summaries if s.get("status") == "complete")

    parts = {
        "technique": _clamp(100 * mean(forms)),
        "depth": _clamp(100 * mean(roms)) if roms else None,
        "completion": _clamp(100 * complete / planned_sets) if planned_sets > 0 else None,
        "consistency": _clamp(100 * (1 - uneven / len(judged))) if judged else None,
    }
    score = _combine(parts)
    low_confidence = sum(1 for sc in set_scores if sc.get("quality") == "low_confidence")
    facts = {"n": counted, "done": complete, "planned": planned_sets, "shallow": shallow,
             "uneven": uneven, "judged": len(judged)}
    feedback = _feedback(parts, facts, None, {}, None, kind="time")
    provisional = low_confidence > PROVISIONAL_SHARE * len(set_scores)
    return {
        **base,
        "status": "provisional" if provisional else "scored",
        "score": round(score),
        "grade": grade(score),
        "parts": _parts_view(parts),
        "correct_pct": round(100 * full / counted),
        "avg_depth": round(mean(roms), 2) if roms else None,
        **feedback,
        "tracking_note": ("Some joints were hard to see, so treat this score as a rough guide. "
                          "A clearer camera view will make it exact.") if provisional else None,
    }


# ---------------------------------------------------------------- shared

def _combine(parts: dict[str, float | None]) -> float:
    """Weighted mean over the parts that could be measured (weights renormalised)."""
    present = {k: v for k, v in parts.items() if v is not None}
    total = sum(WEIGHTS[k] for k in present)
    return sum(WEIGHTS[k] * v for k, v in present.items()) / total


def _parts_view(parts: dict[str, float | None]) -> list[dict]:
    return [
        {"key": key, "label": LABELS[key], "weight": round(WEIGHTS[key] * 100),
         "score": None if parts[key] is None else round(parts[key])}
        for key in WEIGHTS
    ]


def _feedback(parts: dict[str, float | None], facts: dict, top_fault: dict | None,
              templates: dict[str, dict], rom_rule_id: str | None, *, kind: str) -> dict:
    unit = "rep" if kind == "reps" else "lift"
    measured = {k: v for k, v in parts.items() if v is not None}

    strengths: list[str] = []
    for key, value in sorted(measured.items(), key=lambda kv: -kv[1]):
        if value < STRENGTH_MIN or len(strengths) == 2:
            break
        strengths.append(_strength_text(key, facts, unit, kind))

    focus = None
    weakest_key, weakest = min(measured.items(), key=lambda kv: kv[1])
    if weakest < FOCUS_BELOW:
        focus = {"part": weakest_key, "label": LABELS[weakest_key],
                 **_focus_text(weakest_key, facts, unit, kind, top_fault, templates, rom_rule_id)}

    if focus is None:
        headline = "Everything came together — clean, full-range and steady. Keep this quality as you add reps."
    elif strengths:
        headline = f"{strengths[0]} Next, work on {focus['label'].lower()}."
    else:
        headline = f"Your biggest gain next time is {focus['label'].lower()}."
    return {"headline": headline, "strengths": strengths, "focus": focus}


def _strength_text(key: str, f: dict, unit: str, kind: str) -> str:
    if key == "technique":
        if kind == "reps" and f.get("faulty"):
            return f"Clean technique — only {f['faulty']} of {_plural(f['n'], unit)} picked up a fault."
        return "Clean technique — no form faults held you back."
    if key == "depth":
        full = f["n"] - f["shallow"]
        return f"Full range of motion on {full} of {_plural(f['n'], unit)}."
    if key == "completion":
        what = "reps" if kind == "reps" else "sets"
        return f"You finished all {f['planned']} planned {what}."
    if kind == "time":
        return "Balanced — both legs worked evenly."
    return "Steady from your first rep to your last."


def _focus_text(key: str, f: dict, unit: str, kind: str, top_fault: dict | None,
                templates: dict[str, dict], rom_rule_id: str | None) -> dict:
    if key == "technique":
        if top_fault:
            tmpl = templates.get(top_fault["rule"]) or {}
            fix = tmpl.get("coaching") or tmpl.get("cue") or ""
            return {"text": f"{top_fault['issue_name']} showed up on {top_fault['flagged_reps']} of "
                            f"{_plural(f['n'], unit)}.", "tip": fix, "rule": top_fault["rule"]}
        return {"text": "Form faults cost you points on several reps.",
                "tip": "Slow down and own each position before moving on."}
    if key == "depth":
        tmpl = templates.get(rom_rule_id or "") or {}
        tip = tmpl.get("coaching") or tmpl.get("cue") or "Move through the full range on every rep, even if it means fewer reps."
        if f["shallow"]:
            return {"text": f"{f['shallow']} of {_plural(f['n'], unit)} came up short of full range.", "tip": tip}
        return {"text": "Most reps stopped a little short of full range.", "tip": tip}
    if key == "completion":
        what = "reps" if kind == "reps" else "timed sets"
        return {"text": f"You finished {f['done']} of {f['planned']} planned {what}.",
                "tip": "Pick a target you can finish with good form, then add to it next time."}
    if kind == "time":
        return {"text": f"One leg lifted lower than the other in {f['uneven']} of {_plural(f['judged'], 'set')}.",
                "tip": "Match the height of each knee drive, left and right."}
    if f["n"] >= FATIGUE_MIN_REPS and f["first"] - f["last"] >= FATIGUE_DROP:
        return {"text": f"Form faded from {f['first']} on your first reps to {f['last']} on your last.",
                "tip": "Rest a little longer between sets, or do fewer reps per set until the last ones look like the first."}
    if f.get("tempo") is not None and f["tempo"] < FOCUS_BELOW:
        return {"text": "Your rep speed changed a lot from rep to rep.",
                "tip": "Use the same smooth tempo on every rep — the same count down and up."}
    return {"text": "Rep quality went up and down through the set.",
            "tip": "Reset your position between reps so each one starts the same way."}


def trend(score: int | None, previous: int | None) -> dict | None:
    """Comparison with the last scored session of the same exercise."""
    if score is None:
        return None
    if previous is None:
        return {"previous": None, "delta": None, "text": "Your first Workout Score for this exercise — this is your baseline."}
    delta = score - previous
    if delta > 0:
        text = f"Up {delta} from last time."
    elif delta < 0:
        text = f"Down {-delta} from last time — one off day is normal; aim to match {previous} next session."
    else:
        text = "Same as last time — consistent."
    return {"previous": previous, "delta": delta, "text": text}


def activity_metrics(report: dict) -> dict:
    """The `metrics` object for this exercise's activity_sessions row (Integration Contract §4)."""
    ws = report.get("workout_score") or {}
    if report.get("measure") == "time":
        summary = report.get("summary") or {}
        return {"lifts": summary.get("counted_lifts", 0), "correct_pct": ws.get("correct_pct"),
                "avg_depth": ws.get("avg_depth"), "workout_score": ws.get("score")}
    summary = report.get("summary") or {}
    not_counted = summary.get("not_counted") or {}
    return {"reps": summary.get("total_reps", 0), "good_reps": summary.get("good_reps", 0),
            "reps_not_counted": sum(not_counted.values()), "correct_pct": ws.get("correct_pct"),
            "avg_depth": ws.get("avg_depth"), "workout_score": ws.get("score")}
