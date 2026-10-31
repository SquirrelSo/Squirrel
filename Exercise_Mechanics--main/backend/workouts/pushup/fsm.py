"""Push-up phase vocabulary over the exercise-agnostic rep FSM.

The state machine itself lives in ``backend.engine.rep_fsm``; it derives every lifecycle role from
the configured transition graph. This module only pins the push-up phase names its adapter
references. A push-up is descend-first, so it shares squat's vocabulary while measuring something
completely different.
"""

from __future__ import annotations

from backend.engine.rep_fsm import (
    AttemptClassification,
    AttemptResult,
    RepFSM,
    RepState,
    fsm_diagnostics,
)

SETUP, DESCENT, BOTTOM, ASCENT, RESET = "setup", "descent", "bottom", "ascent", "reset"

PushUpFSM = RepFSM

__all__ = [
    "ASCENT",
    "AttemptClassification",
    "AttemptResult",
    "BOTTOM",
    "DESCENT",
    "PushUpFSM",
    "RESET",
    "RepFSM",
    "RepState",
    "SETUP",
    "fsm_diagnostics",
]
