"""Stage 7 persisted-session `/ws/setup` integration tests."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import WebSocketDisconnect

from backend import config
from backend.auth import tokens
from backend.sessions.store import create_session_record
from backend.training import router as training_router
from backend.training.baseline import load_baseline_document
from backend.training.router import setup_ws, train_ws
from backend.users.store import create_user_record

_PROFILE = {
    "first_name": "Setup",
    "last_name": "Socket",
    "gender": "other",
    "height_cm": 180.0,
    "weight_kg": 75.0,
    "date_of_birth": "1990-01-01",
    "mobile": "1234567",
    "email": "setup-socket@example.test",
}


def _plan() -> dict:
    return {
        "exercise_id": "squat",
        "exercise_name": "Squat",
        "variant": None,
        "sets": 3,
        "target": {"type": "reps", "value": 8},
        "rest_seconds": 60,
        "metadata": {
            "body_part": "Lower Body",
            "training_tag": "Strength",
            "view": "front",
        },
    }


def _keypoints(*, hidden: tuple[str, ...] = ()) -> dict:
    points = {
        "nose": (200.0, 20.0),
        "left_shoulder": (250.0, 50.0),
        "right_shoulder": (150.0, 50.0),
        "left_hip": (250.0, 100.0),
        "right_hip": (150.0, 100.0),
        "left_knee": (250.0, 200.0),
        "right_knee": (150.0, 200.0),
        "left_ankle": (250.0, 300.0),
        "right_ankle": (150.0, 300.0),
    }
    return {
        name: {
            "x": x,
            "y": y,
            "z": 0.0,
            "v": 0.2 if name in hidden else 0.99,
        }
        for name, (x, y) in points.items()
    }


def _payload(timestamp: float, *, hidden: tuple[str, ...] = ()) -> dict:
    return {"t_ms": timestamp, "keypoints": _keypoints(hidden=hidden)}


def _complete_capture_messages() -> list[dict]:
    messages = [_payload(0.0), _payload(2000.0)]
    messages.extend(
        _payload(2050.0 + index * (3000.0 / 45.0))
        for index in range(46)
    )
    return messages


class FakeWebSocket:
    def __init__(self, query_params: dict[str, str], messages: list[dict] | None = None):
        self.query_params = query_params
        self._messages = list(messages or [])
        self.accepted = False
        self.sent: list[dict] = []
        self.closed: tuple[int, str] | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def receive_json(self) -> dict:
        if not self._messages:
            raise WebSocketDisconnect()
        return self._messages.pop(0)

    async def send_json(self, value: dict) -> None:
        self.sent.append(value)

    async def close(self, code: int, reason: str) -> None:
        self.closed = (code, reason)


@pytest.fixture
def persisted_session(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USERS_DIR", tmp_path)
    user_id = create_user_record(dict(_PROFILE))["user_id"]
    record = create_session_record(user_id, _plan(), "beginner")
    return user_id, record["session_id"]


def _query(user_id: str, session_id: str, *, set_no: str = "1") -> dict[str, str]:
    return {
        "user_id": user_id,
        "token": tokens.issue_access_token(user_id)[0],
        "session_id": session_id,
        "exercise": "squat",
        "set_no": set_no,
    }


def _run_setup(websocket: FakeWebSocket) -> None:
    asyncio.run(setup_ws(websocket))  # type: ignore[arg-type]


def _run_train(websocket: FakeWebSocket) -> None:
    asyncio.run(train_ws(websocket))  # type: ignore[arg-type]


def test_setup_ready_is_sent_only_after_atomic_save_and_live_adapter_acceptance(
    persisted_session,
) -> None:
    user_id, session_id = persisted_session
    query = _query(user_id, session_id)
    websocket = FakeWebSocket(query, _complete_capture_messages())

    _run_setup(websocket)

    assert websocket.accepted is True
    assert websocket.closed is None
    assert all(message["v"] == 1 for message in websocket.sent)
    assert websocket.sent[-1]["type"] == "setup.ready"
    final = websocket.sent[-1]["data"]
    assert final["phase"] == "ready"
    assert final["baseline_ready"] is True
    assert final["start"] is True
    assert all(message["data"]["start"] is False for message in websocket.sent[:-1])

    path = (
        config.USERS_DIR
        / user_id
        / "sessions"
        / session_id
        / "workouts"
        / "squat"
        / "set_1"
        / "baseline_kp_data"
        / "squat_baseline_keypoints.json"
    )
    loaded = load_baseline_document(path)
    assert loaded is not None
    baseline, quality = loaded
    assert set(baseline) == set(_keypoints())
    assert quality is not None
    assert quality["valid_samples"] == 46
    assert quality["valid_duration_ms"] == pytest.approx(3000.0)

    training = FakeWebSocket(query, [_payload(0.0)])
    _run_train(training)
    assert training.sent[0]["type"] == "train.status"
    assert training.closed is None


def test_malformed_setup_frame_does_not_advance_dwell_or_close_socket(
    persisted_session,
) -> None:
    user_id, session_id = persisted_session
    malformed = {
        "t_ms": 1500.0,
        "keypoints": {"invented_joint": {"x": 0.0, "y": 0.0, "v": 1.0}},
    }
    websocket = FakeWebSocket(
        _query(user_id, session_id),
        [_payload(0.0), malformed, _payload(1999.0), _payload(2000.0)],
    )

    _run_setup(websocket)

    assert [message["type"] for message in websocket.sent] == [
        "setup.status",
        "setup.error",
        "setup.status",
        "setup.status",
    ]
    assert websocket.sent[1]["data"]["code"] == "MALFORMED_FRAME"
    assert websocket.sent[2]["data"]["phase"] == "precheck"
    assert websocket.sent[2]["data"]["dwell"]["held_ms"] == 1999.0
    assert websocket.sent[3]["data"]["phase"] == "collecting"
    assert websocket.closed is None


def test_persistence_failure_never_emits_ready_or_start(
    persisted_session,
    monkeypatch,
) -> None:
    user_id, session_id = persisted_session

    def fail_save(*_args, **_kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(training_router, "save_baseline", fail_save)
    websocket = FakeWebSocket(
        _query(user_id, session_id),
        _complete_capture_messages(),
    )

    _run_setup(websocket)

    assert "setup.ready" not in [message["type"] for message in websocket.sent]
    assert any(
        message["type"] == "setup.error"
        and message["data"]["code"] == "BASELINE_NOT_READY"
        for message in websocket.sent
    )
    assert websocket.sent[-1]["type"] == "setup.status"
    assert websocket.sent[-1]["data"]["phase"] == "precheck"
    assert websocket.sent[-1]["data"]["start"] is False


@pytest.mark.parametrize("token_for", [None, "someone-else"])
def test_setup_socket_needs_the_users_own_token(persisted_session, token_for):
    user_id, session_id = persisted_session
    query = {**_query(user_id, session_id), "token": tokens.issue_access_token(token_for)[0] if token_for else ""}
    websocket = FakeWebSocket(query, _complete_capture_messages())
    _run_setup(websocket)
    assert websocket.sent[0]["data"]["code"] == "UNAUTHORIZED"
    assert websocket.closed == (1008, "UNAUTHORIZED")


def test_sockets_skip_the_token_check_when_auth_is_switched_off(persisted_session, monkeypatch):
    monkeypatch.setenv(config.REQUIRE_AUTH_ENV, "0")
    user_id, session_id = persisted_session
    query = {k: v for k, v in _query(user_id, session_id).items() if k != "token"}
    websocket = FakeWebSocket(query, _complete_capture_messages())
    _run_setup(websocket)
    assert websocket.sent[-1]["type"] == "setup.ready"
