"""Workout with Partner: two people race the same rep exercise for a fixed 1, 3 or 5 minutes.

    policy.py    every number and vocabulary the feature decides on
    model.py     the session document and its rules — phase, seats, reps — pure, no I/O, no clock
    store.py     persistence: shared_workout_sessions (migration 007) or one JSON file per session
    presence.py  who is connected (socket open or a recent request), in-process
    hub.py       the per-session WebSocket fan-out and the sweep that pushes timed phase changes
    service.py   the use cases, with Social's blocks and names
    router.py    /api/workout-sessions/* and /ws/workout-sessions/{id}

Owned by Exercise (ADR-032). Reps are hand-tapped in this version, so nothing is written to
activity_sessions and nothing is earned per rep: a finished race earns each finishing player one
flat shared_workout_finished award from the Run Module, settled once per session (service.py).
"""
