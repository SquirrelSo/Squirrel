"""Stage 6 persisted-session `/ws/train` protocol integration tests."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import WebSocketDisconnect

from backend import config
from backend.auth import tokens
from backend.sessions.store import create_session_record
from backend.training.debug_capture import TrainingDebugCapture
from backend.training.router import train_ws
from backend.users.store import create_user_record

# Synthetic reps here are faster and shallower than the live counting policy accepts (conftest).
pytestmark = pytest.mark.usefixtures("legacy_rep_counting")

_PROFILE = {
    "first_name": "Training",
    "last_name": "Socket",
    "gender": "other",
    "height_cm": 180.0,
    "weight_kg": 75.0,
    "date_of_birth": "1990-01-01",
    "mobile": "1234567",
    "email": "training-socket@example.test",
}


def _plan() -> dict:
    return {
        "exercise_id": "squat",
        "exercise_name": "Squat",
        "variant": None,
        "sets": 3,
        "target": {"type": "reps", "value": 2},
        "rest_seconds": 60,
        "metadata": {"body_part": "Lower Body", "training_tag": "Strength", "view": "front"},
    }


def _keypoints(progress: float, *, shoulders: bool = True) -> dict:
    hip_y = 100.0 + progress * 100.0
    points = {
        "left_hip": {"x": 220.0, "y": hip_y, "v": 0.9},
        "right_hip": {"x": 180.0, "y": hip_y, "v": 0.9},
        "left_knee": {"x": 220.0, "y": 200.0, "v": 0.9},
        "right_knee": {"x": 180.0, "y": 200.0, "v": 0.9},
        "left_ankle": {"x": 250.0, "y": 300.0, "v": 0.9},
        "right_ankle": {"x": 150.0, "y": 300.0, "v": 0.9},
    }
    if shoulders:
        points["left_shoulder"] = {"x": 250.0, "y": 50.0, "v": 0.9}
        points["right_shoulder"] = {"x": 150.0, "y": 50.0, "v": 0.9}
    return points


def _payload(progress: float, timestamp: float) -> dict:
    return {"t_ms": timestamp, "keypoints": _keypoints(progress)}


_FULL_MESSAGES = [
    _payload(0.0, 0),
    _payload(0.3, 100),
    _payload(0.6, 200),
    _payload(0.9, 300),
    _payload(0.95, 400),
    _payload(0.9, 500),
    _payload(0.7, 600),
    _payload(0.3, 700),
    _payload(0.05, 800),
]


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


def _query(user_id: str, session_id: str, *, exercise: str = "squat", set_no: str = "1"):
    return {
        "user_id": user_id,
        "token": tokens.issue_access_token(user_id)[0],
        "session_id": session_id,
        "exercise": exercise,
        "set_no": set_no,
    }


def _write_baseline(user_id: str, session_id: str, *, set_no: int = 1) -> None:
    directory = (
        config.USERS_DIR
        / user_id
        / "sessions"
        / session_id
        / "workouts"
        / "squat"
        / f"set_{set_no}"
        / "baseline_kp_data"
    )
    directory.mkdir(parents=True)
    (directory / "squat_baseline_keypoints.json").write_text(
        json.dumps(
            {
                name: {axis: value for axis, value in landmark.items() if axis != "v"}
                for name, landmark in _keypoints(0.0).items()
            }
        ),
        encoding="utf-8",
    )


def _set_dir(user_id: str, session_id: str, *, set_no: int = 1):
    return (
        config.USERS_DIR
        / user_id
        / "sessions"
        / session_id
        / "workouts"
        / "squat"
        / f"set_{set_no}"
    )


def _run(websocket: FakeWebSocket) -> None:
    asyncio.run(train_ws(websocket))  # type: ignore[arg-type]


def test_persisted_training_socket_streams_versioned_scored_full_rep(persisted_session):
    user_id, session_id = persisted_session
    _write_baseline(user_id, session_id)
    websocket = FakeWebSocket(_query(user_id, session_id), _FULL_MESSAGES)

    _run(websocket)

    assert websocket.accepted is True
    assert websocket.closed is None
    assert len(websocket.sent) == len(_FULL_MESSAGES)
    assert all(message["v"] == 1 and message["type"] == "train.status" for message in websocket.sent)
    final = websocket.sent[-1]["data"]
    assert final["counters"] == {
        "attempts": 1,
        "qualified": 1,
        "full_rom": 1,
        "shallow": 0,
        "invalid": 0,
        "not_counted": {"shallow": 0, "too_fast": 0},
    }
    assert final["last_rep"]["score"] == 100.0
    assert final["score_coverage"]["reliable"] is True
    assert final["set"]["completed_reps"] == 1
    assert final["set"]["remaining_reps"] == 1

    rep_dir = _set_dir(user_id, session_id) / "rep_1"
    assert len(tuple((rep_dir / "keypoints").glob("frame_*.json"))) == len(_FULL_MESSAGES)
    assert len(tuple((rep_dir / "rules").glob("frame_*.json"))) == len(_FULL_MESSAGES)
    keypoints = json.loads((rep_dir / "keypoints/frame_1.json").read_text(encoding="utf-8"))
    assert len(keypoints["keypoints"]) == 33
    assert keypoints["keypoints"]["nose"] == {"x": "nan", "y": "nan", "z": "nan", "v": "nan"}
    rules = json.loads((rep_dir / "rules/frame_1.json").read_text(encoding="utf-8"))
    assert rules["rules"]["depth"]["active"] is True
    assert rules["rules"]["knee_valgus"]["active"] is True
    assert rules["rules"]["knee_valgus"]["phase_active"] is False
    metadata = json.loads((rep_dir / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["templates"]["depth"]["full_rom_gate"] == 0.85
    score = json.loads((rep_dir / "form_score.json").read_text(encoding="utf-8"))
    assert score["final_score"] == 100.0
    assert set(score["phase_scores"]) == {"descent", "bottom", "ascent"}
    assert all(
        phase["score"] == 100.0 for phase in score["phase_scores"].values()
    )
    assert score["last_attempt"]["score"] == 100.0


def test_missing_exact_set_baseline_fails_before_receiving_frames(persisted_session):
    user_id, session_id = persisted_session
    _write_baseline(user_id, session_id, set_no=1)
    websocket = FakeWebSocket(_query(user_id, session_id, set_no="2"), [_payload(0.0, 0)])

    _run(websocket)

    assert websocket.sent == [
        {
            "v": 1,
            "type": "train.error",
            "data": {
                "code": "BASELINE_NOT_READY",
                "detail": "the requested session set has no readable baseline",
            },
        }
    ]
    assert websocket.closed == (1008, "BASELINE_NOT_READY")


def test_malformed_frame_is_rejected_without_advancing_timestamp_or_closing(persisted_session):
    user_id, session_id = persisted_session
    _write_baseline(user_id, session_id)
    malformed = {
        "t_ms": 100,
        "keypoints": {"invented_joint": {"x": 0, "y": 0, "v": 1}},
    }
    websocket = FakeWebSocket(
        _query(user_id, session_id),
        [_payload(0.0, 0), malformed, _payload(0.0, 50)],
    )

    _run(websocket)

    assert [message["type"] for message in websocket.sent] == [
        "train.status",
        "train.error",
        "train.status",
    ]
    error = websocket.sent[1]["data"]
    assert error["code"] == "MALFORMED_FRAME"
    assert "unknown landmark" in error["detail"]
    assert websocket.sent[-1]["data"]["counters"]["attempts"] == 0
    assert websocket.closed is None


def test_debug_persistence_failure_is_reported_and_closes_with_server_error(
    persisted_session,
    monkeypatch,
):
    user_id, session_id = persisted_session
    _write_baseline(user_id, session_id)

    def fail_record(*_args, **_kwargs):
        raise OSError("debug disk unavailable")

    monkeypatch.setattr(TrainingDebugCapture, "record", fail_record)
    websocket = FakeWebSocket(_query(user_id, session_id), [_payload(0.0, 0)])

    _run(websocket)

    assert websocket.sent == [
        {
            "v": 1,
            "type": "train.error",
            "data": {
                "code": "DEBUG_PERSISTENCE_FAILED",
                "detail": "debug disk unavailable",
            },
        }
    ]
    assert websocket.closed == (1011, "DEBUG_PERSISTENCE_FAILED")


def test_missing_session_uses_stable_session_required_error():
    websocket = FakeWebSocket(
        {"user_id": "some-user", "token": tokens.issue_access_token("some-user")[0], "exercise": "squat", "set_no": "1"}
    )
    _run(websocket)
    assert websocket.sent[0]["data"]["code"] == "SESSION_REQUIRED"
    assert websocket.closed == (1008, "SESSION_REQUIRED")


@pytest.mark.parametrize(
    ("query_change", "expected"),
    [
        ({"session_id": "missing"}, "INVALID_SESSION"),
        ({"exercise": "bicep_curl"}, "INVALID_EXERCISE"),
        ({"set_no": "4"}, "INVALID_SET"),
    ],
)
def test_invalid_training_identity_uses_stable_error_codes(
    persisted_session,
    query_change,
    expected,
):
    user_id, session_id = persisted_session
    query = _query(user_id, session_id)
    query.update(query_change)
    websocket = FakeWebSocket(query)
    _run(websocket)
    assert websocket.sent[0]["data"]["code"] == expected
    assert websocket.closed == (1008, expected)


@pytest.mark.parametrize("token_for", [None, "someone-else"])
def test_training_socket_needs_the_users_own_token(persisted_session, token_for):
    user_id, session_id = persisted_session
    query = {**_query(user_id, session_id), "token": tokens.issue_access_token(token_for)[0] if token_for else ""}
    websocket = FakeWebSocket(query)
    _run(websocket)
    assert websocket.sent[0]["data"]["code"] == "UNAUTHORIZED"
    assert websocket.closed == (1008, "UNAUTHORIZED")
