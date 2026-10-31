"""What a completed attempt means to the person: shared by every rep exercise's adapter.

A rep that does not count (rep_fsm: short of the full-ROM gate while shallow reps do not count, or
faster than the exercise's minimum rep time) is said at once, while the person can still act on it,
and stays visible in the counters and the attempt record, never silently dropped. A shallow rep that
does count is warned about at once in the same way.
"""

from __future__ import annotations

from backend.engine.cues import CueCandidate
from backend.engine.rep_fsm import AttemptResult, RepState

# How long a "did not count" cue stays up (ms): long enough to read between two reps.
NOT_COUNTED_CUE_MS = 2500.0


def fsm_policy_inputs(fsm: dict) -> dict:
    """The optional counting policy (fsm.yaml) as RepFSM keyword arguments."""
    return {
        "count_shallow": fsm.get("count_shallow", True),
        "min_rep_ms": fsm.get("min_rep_ms"),
    }


def not_counted_cue(
    attempt: AttemptResult | None,
    *,
    fsm: dict,
    rom_rule_id: str,
    rom_template: dict,
) -> CueCandidate | None:
    """The cue for an attempt that just failed to count because of the counting policy."""
    if attempt is None or attempt.qualified:
        return None
    if attempt.reason == "too_fast":
        return CueCandidate(
            "tempo", fsm["too_fast_cue"], 1, display_ms=NOT_COUNTED_CUE_MS,
            coaching="Reps count when they are controlled: lower and rise at a steady pace.",
        )
    if attempt.reason == "shallow":
        return CueCandidate(
            rom_rule_id, f"Not counted: {rom_template['cue']}", 1,
            display_ms=NOT_COUNTED_CUE_MS, coaching=rom_template.get("coaching"),
        )
    return None


def shallow_warning_cue(
    attempt: AttemptResult | None,
    *,
    rom_rule_id: str,
    rom_template: dict,
) -> CueCandidate | None:
    """The warning for a shallow rep that still counted (count_shallow: true): said at once, like a
    rep that did not count, so a set of half reps never passes without a word."""
    if attempt is None or not attempt.qualified or attempt.classification != "shallow":
        return None
    return CueCandidate(
        rom_rule_id, f"Shallow rep: {rom_template['cue']}", 1,
        display_ms=NOT_COUNTED_CUE_MS, coaching=rom_template.get("coaching"),
    )


def counters(state: RepState) -> dict:
    """The live counters. `qualified` counts toward the set; `not_counted` explains the invalid
    attempts that were rep-shaped but failed the counting policy."""
    return {
        "attempts": state.attempt_count,
        "qualified": state.qualified_count,
        "full_rom": state.full_rom_count,
        "shallow": state.shallow_count,
        "invalid": state.invalid_attempt_count,
        "not_counted": {"shallow": state.shallow_not_counted, "too_fast": state.too_fast_count},
    }


def attempt_fields(attempt: AttemptResult) -> dict:
    """Why the attempt did (not) count, for the attempt record."""
    return {"reason": attempt.reason, "duration_ms": attempt.duration_ms}
