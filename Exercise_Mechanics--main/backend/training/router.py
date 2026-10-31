"""Versioned setup and training WebSocket transport for persisted session sets.

`/ws/setup` feeds validated frames into the exercise-neutral combined gate and capture flow. A
candidate reaches `setup.ready` only after exercise-specific validation, live-adapter construction,
and atomic persistence. The pure state machine and exercise calculations live outside this router.

Query params: user_id, exercise, session_id, set_no. Every value must match a persisted session;
there are no product fallbacks. The baseline lands at
    data/users/{uid}/sessions/{session_id}/workouts/{exercise}/set_{set_no}/baseline_kp_data/
After `setup.ready` the client reconnects to train, whose rules load the accepted baseline.
"""

from __future__ import annotations

from asyncio import get_running_loop, to_thread
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend import config, live
from backend.auth.tokens import verify_access_token
from backend.config import user_dir
from backend.db.exercise_sessions import sync_session
from backend.core.frame import FrameValidationError, validate_training_frame
from backend.sessions.store import SessionAccess, SessionAccessError, validate_session_access
from backend.training.baseline import load_baseline_document, save_baseline
from backend.training.builders import build_setup_adapter, build_training_adapter
from backend.training.target_contract import MovementTarget, MovementTargetError, parse_movement_target
from backend.training.debug_capture import TrainingDebugCapture
from backend.training.setup_config import load_setup
from backend.training.setup_flow import READY, VALIDATING, SetupOrchestrator, SetupStatus

router = APIRouter()
_PROTOCOL_VERSION = 1


def _status_dict(s: SetupStatus) -> dict:
    def condition(value) -> dict:
        return {
            "template_id": value.template_id,
            "status": value.status,
            "reason_id": value.reason_id,
            "cue": value.cue,
            "measurements": dict(value.measurements),
        }

    quality = None if s.quality is None else s.quality.as_dict()
    failures = [condition(result) for result in s.failures]
    validation = [condition(result) for result in s.validation_results]
    cue_source = next(
        (result for result in (*s.failures, *s.validation_results) if result.cue),
        None,
    )
    return {
        "phase": s.phase,
        "missing": list(s.missing),
        "conditions": [condition(result) for result in s.conditions],
        "failures": failures,
        "dwell": {"held_ms": s.dwell_ms, "required_ms": s.stable_ms},
        "capture": {
            "valid_ms": s.capture_valid_ms,
            "required_ms": s.capture_required_ms,
            "progress": s.capture_progress,
            "frames_collected": s.frames_collected,
            "min_valid_samples": s.min_valid_samples,
            "observed_frames": s.observed_frames,
            "valid_coverage": s.valid_coverage,
            "invalid_ms": s.invalid_ms,
            "paused": s.capture_paused,
        },
        "quality": quality,
        "validation_results": validation,
        "baseline_candidate_ready": s.baseline_candidate_ready,
        "baseline_ready": s.baseline_ready,
        "start": s.phase == READY,
        "cue": (
            None
            if cue_source is None
            else {"rule_id": cue_source.template_id, "text": cue_source.cue}
        ),
    }


def _socket_signed_in(websocket: WebSocket) -> bool:
    """Browsers can't set headers on a WebSocket, so the access token rides in `?token=`. It must
    belong to the `user_id` the socket asks for. Always true while auth is switched off."""
    if not config.auth_required():
        return True
    token = websocket.query_params.get("token") or ""
    return verify_access_token(token) == websocket.query_params.get("user_id")


async def _session_access(websocket: WebSocket) -> SessionAccess | None:
    """Resolve the exact persisted plan or reject the socket without any identity fallback."""
    try:
        return validate_session_access(
            websocket.query_params.get("user_id"),
            websocket.query_params.get("session_id"),
            websocket.query_params.get("exercise"),
            websocket.query_params.get("set_no"),
        )
    except SessionAccessError as exc:
        await websocket.send_json({"error": {"code": exc.code, "detail": exc.detail}})
        await websocket.close(code=1008, reason=exc.code)
        return None


async def _setup_access(websocket: WebSocket) -> SessionAccess | None:
    if not _socket_signed_in(websocket):
        await websocket.send_json(
            _envelope("setup.error", {"code": "UNAUTHORIZED", "detail": "sign in to use this session"})
        )
        await websocket.close(code=1008, reason="UNAUTHORIZED")
        return None
    if not websocket.query_params.get("session_id"):
        await websocket.send_json(
            _envelope(
                "setup.error",
                {"code": "SESSION_REQUIRED", "detail": "a persisted session_id is required"},
            )
        )
        await websocket.close(code=1008, reason="SESSION_REQUIRED")
        return None
    try:
        return validate_session_access(
            websocket.query_params.get("user_id"),
            websocket.query_params.get("session_id"),
            websocket.query_params.get("exercise"),
            websocket.query_params.get("set_no"),
        )
    except SessionAccessError as exc:
        if exc.code == "invalid_set":
            code = "INVALID_SET"
        elif exc.code in {"invalid_exercise", "exercise_unavailable", "exercise_mismatch"}:
            code = "INVALID_EXERCISE"
        else:
            code = "INVALID_SESSION"
        await websocket.send_json(
            _envelope("setup.error", {"code": code, "detail": exc.detail})
        )
        await websocket.close(code=1008, reason=code)
        return None


@router.websocket("/ws/setup")
async def setup_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    access = await _setup_access(websocket)
    if access is None:
        return
    uid = access.user_id
    exercise = access.exercise_id
    session_id = access.session_id
    set_no = access.set_no

    cfg = load_setup(exercise)
    exercise_adapter = build_setup_adapter(exercise)
    orch = SetupOrchestrator(cfg, exercise_adapter)
    print(f"[ws/setup] user={uid} exercise={exercise} session={session_id} set={set_no}")

    previous_t_ms: float | None = None
    try:
        while True:
            try:
                payload = await websocket.receive_json()
                frame = validate_training_frame(payload, previous_t_ms=previous_t_ms)
            except WebSocketDisconnect:
                raise
            except (FrameValidationError, TypeError, ValueError) as exc:
                await websocket.send_json(
                    _envelope(
                        "setup.error",
                        {"code": "MALFORMED_FRAME", "detail": str(exc)},
                    )
                )
                continue
            previous_t_ms = frame.t_ms
            status = orch.update(frame.keypoints, frame.t_ms)
            if status.phase == VALIDATING:
                target = _movement_target(access)
                if target is None or orch.baseline is None or orch.quality is None:
                    status = orch.reject_candidate("baseline_candidate_incomplete")
                else:
                    try:
                        build_training_adapter(
                            exercise,
                            baseline=orch.baseline,
                            target=target,
                            variant=_variant(access),
                        )
                        set_dir = (
                            user_dir(uid)
                            / "sessions"
                            / session_id
                            / "workouts"
                            / exercise
                            / f"set_{set_no}"
                        )
                        path = save_baseline(
                            set_dir,
                            orch.baseline,
                            orch.quality,
                            str(cfg.baseline_file),
                        )
                    except (OSError, TypeError, ValueError, RuntimeError) as exc:
                        status = orch.reject_candidate(
                            "baseline_adapter_or_save_rejected",
                            "Hold the setup position and try capture again.",
                        )
                        await websocket.send_json(
                            _envelope(
                                "setup.error",
                                {"code": "BASELINE_NOT_READY", "detail": str(exc)},
                            )
                        )
                    else:
                        status = orch.mark_ready()
                        print(f"[ws/setup] baseline saved → {path}")
            message_type = "setup.ready" if status.phase == READY else "setup.status"
            await websocket.send_json(_envelope(message_type, _status_dict(status)))
    except WebSocketDisconnect:
        print("[ws/setup] disconnected")


# /ws/train — adapter-driven live coaching

def _load_baseline(
    access: SessionAccess,
    filename: str | None,
) -> dict | None:
    """Load only the exact persisted baseline belonging to this session exercise and set."""
    if not filename or Path(filename).name != filename:
        return None
    path = (
        user_dir(access.user_id)
        / "sessions"
        / access.session_id
        / "workouts"
        / access.exercise_id
        / f"set_{access.set_no}"
        / "baseline_kp_data"
        / filename
    )
    try:
        document = load_baseline_document(path)
    except (OSError, ValueError):
        return None
    return None if document is None else document[0]


def _envelope(message_type: str, data: dict) -> dict:
    return {"v": _PROTOCOL_VERSION, "type": message_type, "data": data}


async def _train_error(
    websocket: WebSocket,
    code: str,
    detail: str,
    *,
    close: bool,
    close_code: int = 1008,
) -> None:
    await websocket.send_json(_envelope("train.error", {"code": code, "detail": detail}))
    if close:
        await websocket.close(code=close_code, reason=code)


async def _training_access(websocket: WebSocket) -> SessionAccess | None:
    if not _socket_signed_in(websocket):
        await _train_error(websocket, "UNAUTHORIZED", "sign in to use this session", close=True)
        return None
    if not websocket.query_params.get("session_id"):
        await _train_error(
            websocket,
            "SESSION_REQUIRED",
            "a persisted session_id is required",
            close=True,
        )
        return None
    try:
        return validate_session_access(
            websocket.query_params.get("user_id"),
            websocket.query_params.get("session_id"),
            websocket.query_params.get("exercise"),
            websocket.query_params.get("set_no"),
        )
    except SessionAccessError as exc:
        if exc.code == "invalid_set":
            stable_code = "INVALID_SET"
        elif exc.code in {"invalid_exercise", "exercise_unavailable", "exercise_mismatch"}:
            stable_code = "INVALID_EXERCISE"
        else:
            stable_code = "INVALID_SESSION"
        await _train_error(websocket, stable_code, exc.detail, close=True)
        return None


def _variant(access: SessionAccess) -> str | None:
    """The planned variant (curls: "single" / "double"), or None."""
    variant = access.record.get("plan", {}).get("variant")
    return variant if isinstance(variant, str) else None


def _movement_target(access: SessionAccess) -> MovementTarget | None:
    target = access.record.get("plan", {}).get("target")
    try:
        return parse_movement_target(target)
    except MovementTargetError:
        return None


@router.websocket("/ws/train")
async def train_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    access = await _training_access(websocket)
    if access is None:
        return

    setup_config = load_setup(access.exercise_id)
    baseline = _load_baseline(access, setup_config.baseline_file)
    if baseline is None:
        await _train_error(
            websocket,
            "BASELINE_NOT_READY",
            "the requested session set has no readable baseline",
            close=True,
        )
        return
    target = _movement_target(access)
    if target is None:
        await _train_error(
            websocket,
            "INVALID_SESSION",
            "the persisted session has no valid movement target",
            close=True,
        )
        return
    try:
        adapter = build_training_adapter(
            access.exercise_id,
            baseline=baseline,
            target=target,
            variant=_variant(access),
        )
    except KeyError as exc:
        await _train_error(websocket, "INVALID_EXERCISE", str(exc), close=True)
        return
    except (TypeError, ValueError, RuntimeError) as exc:
        await _train_error(websocket, "BASELINE_NOT_READY", str(exc), close=True)
        return

    set_dir = (
        user_dir(access.user_id)
        / "sessions"
        / access.session_id
        / "workouts"
        / access.exercise_id
        / f"set_{access.set_no}"
    )
    try:
        capture = TrainingDebugCapture(
            set_dir,
            exercise_id=access.exercise_id,
            set_no=access.set_no,
            runtime_metadata=adapter.runtime_metadata(),
        )
    except (OSError, TypeError, ValueError) as exc:
        await _train_error(
            websocket,
            "DEBUG_PERSISTENCE_FAILED",
            str(exc),
            close=True,
            close_code=1011,
        )
        return

    print(
        f"[ws/train] user={access.user_id} exercise={access.exercise_id} "
        f"session={access.session_id} set={access.set_no} adapter=ready"
    )
    with live.training(access.user_id):
        await _train_loop(websocket, access, adapter, capture)


async def _train_loop(websocket: WebSocket, access, adapter, capture) -> None:
    previous_t_ms: float | None = None
    try:
        while True:
            try:
                payload = await websocket.receive_json()
                frame = validate_training_frame(payload, previous_t_ms=previous_t_ms)
            except WebSocketDisconnect:
                raise
            except (FrameValidationError, TypeError, ValueError) as exc:
                await _train_error(websocket, "MALFORMED_FRAME", str(exc), close=False)
                continue
            previous_t_ms = frame.t_ms
            data = adapter.process(frame)
            try:
                await to_thread(
                    capture.record,
                    frame,
                    data,
                    adapter.debug_snapshot(),
                )
            except (OSError, TypeError, ValueError) as exc:
                await _train_error(
                    websocket,
                    "DEBUG_PERSISTENCE_FAILED",
                    str(exc),
                    close=True,
                    close_code=1011,
                )
                return
            await websocket.send_json(_envelope("train.status", data))
            if _set_finished(data):
                _mirror_to_database(access)
    except WebSocketDisconnect:
        print("[ws/train] disconnected")
        _mirror_to_database(access)


def _set_finished(data: dict) -> bool:
    """True only on the one status that closes a set: a rep set's final cycle
    (`set_cycle_completed`) or a timed set reaching its time (`set_completed`)."""
    events = data.get("events") if isinstance(data, dict) else None
    return isinstance(events, dict) and (
        events.get("set_cycle_completed") is True or events.get("set_completed") is True
    )


def _mirror_to_database(access: SessionAccess) -> None:
    """Refresh the session's database row off the socket's path. Fire-and-forget: sync_session never
    raises and is a no-op without DATABASE_URL, so training never waits on, or fails with, the database."""
    get_running_loop().run_in_executor(None, sync_session, access.user_id, access.session_id)
