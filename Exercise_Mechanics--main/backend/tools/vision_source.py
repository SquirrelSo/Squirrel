"""Landmark sources for the local OpenCV tools: a real camera/video, or a synthetic body.

WHY THIS EXISTS. In production this backend never sees pixels — MediaPipe runs in the browser and
the client sends landmark JSON over `/ws/setup` and `/ws/train` (see backend/core/frame.py). That is
the right split for the product, but it makes the rule kernels hard to *watch*: you cannot see what
`pushup_depth` thinks your elbow is doing from a JSON stream.

These sources close that gap for local development only. They produce exactly what the WebSocket
transport produces — `{landmark_name: {"x": px, "y": px, "v": visibility}}` in PIXEL coordinates,
the same convention core/frame.py validates — so the tools that consume them drive the real
orchestrator, the real adapters and the real rule kernels with nothing stubbed.

Nothing in `backend/` imports this module. It needs mediapipe + opencv, which are deliberately NOT
in requirements.txt (the deployed service does not do pose inference); install them with
`pip install -r backend/tools/requirements-vision.txt`.

Two sources:

    MediaPipeSource       a webcam or video file, run through MediaPipe Pose (BlazePose, 33 points),
                          on whichever of MediaPipe's two APIs this install has (see select_backend)
    SyntheticPushUpSource a drawn side-on push-up, no camera and no model, for watching the rule
                          kernels and the setup gate behave on a known-good body
"""

from __future__ import annotations

import math
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

import cv2
import numpy as np

from backend.core.landmarks import ALL_LANDMARKS

#: Where model bundles are cached (gitignored). Override with --model.
MODEL_DIR = Path(__file__).resolve().parent / ".models"
MODEL_VARIANTS = {0: "lite", 1: "full", 2: "heavy"}
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_{variant}/float16/latest/pose_landmarker_{variant}.task"
)


#: Install guidance, kept next to the logic that raises it.
_LEGACY_MISSING = (
    "mediapipe {version} has no mp.solutions.pose.\n"
    "That API exists only up to 0.10.21 (0.10.30+ and 1.0+ are Tasks-only), so:\n"
    "    pip install 'mediapipe==0.10.21'"
)
_MACOS_NEEDS_LEGACY = (
    "mediapipe {version} on macOS would use the Tasks API, which aborts this process inside a\n"
    "Metal calculator (DrishtiMetalHelper / 'Check failed: service_ Service is unavailable').\n"
    "\n"
    "Install the last release with the CPU-only legacy API, which this tool then picks up\n"
    "automatically:\n"
    "\n"
    "    pip install 'mediapipe==0.10.21'\n"
    "\n"
    "Note that 'mediapipe<1.0' is NOT enough - it resolves to 0.10.3x, which is also Tasks-only.\n"
    "To try the Tasks API anyway, pass --backend tasks. To see the tool run with no camera and no\n"
    "model at all, use --source synthetic."
)


@dataclass(frozen=True)
class Frame:
    """One frame: the image to draw on, its landmarks, and its timestamp.

    ``keypoints`` is None when the source produced an image but no body — the caller must treat that
    as tracking unavailability, exactly as a client that stopped sending landmarks would.
    """

    image: np.ndarray
    keypoints: Optional[dict]
    t_ms: float


def resolve_model(complexity: int = 1, model_path: Optional[Path] = None) -> Path:
    """Find the .task bundle, downloading it on first use."""
    if model_path is not None:
        if not model_path.exists():
            raise FileNotFoundError(f"pose model not found: {model_path}")
        return model_path
    variant = MODEL_VARIANTS.get(complexity)
    if variant is None:
        raise ValueError(f"complexity must be one of {sorted(MODEL_VARIANTS)}")
    path = MODEL_DIR / f"pose_landmarker_{variant}.task"
    if path.exists():
        return path
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    url = MODEL_URL.format(variant=variant)
    print(f"downloading pose model ({variant}) → {path}")
    partial = path.with_suffix(".task.part")
    urllib.request.urlretrieve(url, partial)  # noqa: S310 - fixed vendor URL
    partial.replace(path)
    return path


def select_backend(requested: str = "auto") -> str:
    """Pick which MediaPipe API to run: ``"solutions"`` (legacy, CPU-only) or ``"tasks"``.

    Why this choice exists at all — it is a macOS problem. On mediapipe >= 1.0 the Tasks API pose
    graph reaches for Metal inside TensorsToDetectionsCalculator, and on macOS builds where that GPU
    service is not wired up the process does not raise, it ABORTS:

        F graph_service.h:139] Check failed: service_ Service is unavailable.
        @ -[DrishtiMetalHelper initWithCalculatorContext:]

    The legacy `mp.solutions.pose` API has no Metal path, so it runs everywhere — but it was REMOVED
    in mediapipe 1.0. Hence: prefer legacy when it exists (any 0.10.x install, including macOS),
    fall back to Tasks when it does not (1.0+, which is Linux-safe).
    """
    import mediapipe as mp

    has_solutions = hasattr(mp, "solutions") and hasattr(mp.solutions, "pose")
    if requested == "solutions":
        if not has_solutions:
            raise SystemExit(_LEGACY_MISSING.format(version=mp.__version__))
        return "solutions"
    if requested == "tasks":
        if sys.platform == "darwin":
            print(
                "warning: the Tasks backend aborts the PROCESS on many macOS builds "
                "(DrishtiMetalHelper / 'Service is unavailable'). You asked for it explicitly.",
                file=sys.stderr,
            )
        return "tasks"
    if has_solutions:
        return "solutions"
    if sys.platform == "darwin":
        # Refuse rather than let MediaPipe SIGABRT: a CHECK failure inside the graph kills the
        # interpreter with a stack trace that looks like a crash in this tool, which is a miserable
        # thing to hand somebody who just wanted to see their push-ups counted.
        raise SystemExit(_MACOS_NEEDS_LEGACY.format(version=mp.__version__))
    return "tasks"


class MediaPipeSource:
    """A webcam or video file, converted to backend-shaped landmarks.

    Two interchangeable inference backends (see :func:`select_backend`), both producing identical
    pixel-space keypoints, so everything downstream is unaffected by which one ran.
    """

    def __init__(
        self,
        source: str,
        *,
        complexity: int = 1,
        model_path: Optional[Path] = None,
        flip: bool = False,
        width: Optional[int] = None,
        backend: str = "auto",
        min_detection_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
    ) -> None:
        self._flip = flip
        self._width = width
        self._spec: object = int(source) if source.isdigit() else source
        self._capture = cv2.VideoCapture(self._spec)
        if not self._capture.isOpened():
            raise SystemExit(f"could not open video source: {source!r}")
        self.native_fps = self._capture.get(cv2.CAP_PROP_FPS) or 0.0
        self._is_camera = isinstance(self._spec, int)
        self._frame_index = 0
        self._last_stamp = -1

        self.backend = select_backend(backend)
        # Printed before construction on purpose: if the graph aborts the process, this line is the
        # only evidence of which backend was responsible.
        print(f"pose backend: {self.backend} (mediapipe {_mediapipe_version()})")
        if self.backend == "solutions":
            self._open_solutions(complexity, min_detection_confidence, min_tracking_confidence)
        else:
            self._open_tasks(
                complexity, model_path, min_detection_confidence, min_tracking_confidence
            )

    def _open_solutions(
        self, complexity: int, detection_confidence: float, tracking_confidence: float
    ) -> None:
        """Legacy API: the model ships inside the wheel, so nothing is downloaded."""
        import mediapipe as mp

        self._pose = mp.solutions.pose.Pose(
            static_image_mode=False,
            model_complexity=complexity,
            enable_segmentation=False,
            min_detection_confidence=detection_confidence,
            min_tracking_confidence=tracking_confidence,
        )

    def _open_tasks(
        self,
        complexity: int,
        model_path: Optional[Path],
        detection_confidence: float,
        tracking_confidence: float,
    ) -> None:
        from mediapipe import Image, ImageFormat  # noqa: N811 - vendor casing
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        self._Image = Image
        self._ImageFormat = ImageFormat
        options = vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(
                model_asset_path=str(resolve_model(complexity, model_path)),
                # Ask for CPU explicitly. It does not rescue every macOS build (the abort above
                # happens inside a calculator, before the delegate is consulted), but it keeps this
                # path off the GPU wherever the choice is honoured.
                delegate=mp_python.BaseOptions.Delegate.CPU,
            ),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=detection_confidence,
            min_tracking_confidence=tracking_confidence,
            output_segmentation_masks=False,
        )
        self._landmarker = vision.PoseLandmarker.create_from_options(options)

    def frames(self) -> Iterator[Frame]:
        while True:
            ok, image = self._capture.read()
            if not ok:
                return
            if self._flip:
                image = cv2.flip(image, 1)
            if self._width and image.shape[1] != self._width:
                scale = self._width / image.shape[1]
                image = cv2.resize(
                    image,
                    (self._width, int(round(image.shape[0] * scale))),
                    interpolation=cv2.INTER_AREA,
                )

            # A camera's timeline is wall clock; a file's is its own frame rate, so a slow machine
            # replays every frame of a file rather than silently skipping the movement.
            if self._is_camera:
                t_ms = self._capture.get(cv2.CAP_PROP_POS_MSEC) or self._frame_index * 33.3
            else:
                fps = self.native_fps or 30.0
                t_ms = self._frame_index * (1000.0 / fps)
            self._frame_index += 1
            stamp = max(int(t_ms), self._last_stamp + 1)
            self._last_stamp = stamp

            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            keypoints = self._detect(rgb, stamp, image.shape[1], image.shape[0])
            yield Frame(image=image, keypoints=keypoints, t_ms=float(stamp))

    def _detect(self, rgb, stamp: int, width: int, height: int) -> Optional[dict]:
        if self.backend == "solutions":
            rgb.flags.writeable = False
            result = self._pose.process(rgb)
            landmarks = result.pose_landmarks
            return _to_keypoints(landmarks.landmark, width, height) if landmarks else None
        result = self._landmarker.detect_for_video(
            self._Image(image_format=self._ImageFormat.SRGB, data=rgb), stamp
        )
        poses = list(result.pose_landmarks or [])
        return _to_keypoints(poses[0], width, height) if poses else None

    def close(self) -> None:
        self._capture.release()
        try:
            if self.backend == "solutions":
                self._pose.close()
            else:
                self._landmarker.close()
        except Exception:  # pragma: no cover - defensive teardown
            pass


def _mediapipe_version() -> str:
    import mediapipe as mp

    return getattr(mp, "__version__", "unknown")


def _to_keypoints(landmarks, width: int, height: int) -> dict:
    """MediaPipe's normalized landmarks → the backend's pixel-space keypoint mapping.

    Takes a plain sequence of landmarks, which is what both backends can supply, so the conversion
    is shared and the two paths cannot drift apart.
    """
    keypoints: dict[str, dict[str, float]] = {}
    for index, landmark in enumerate(list(landmarks)[: len(ALL_LANDMARKS)]):
        visibility = landmark.visibility
        keypoints[ALL_LANDMARKS[index]] = {
            "x": float(landmark.x) * width,
            "y": float(landmark.y) * height,
            "v": float(visibility if visibility is not None else 0.0),
        }
    return keypoints


# ---------------------------------------------------------------------------
# Synthetic source
# ---------------------------------------------------------------------------

#: Joints the synthetic body defines, per side, plus the head points used for drawing.
_SYNTH_JOINTS = ("shoulder", "elbow", "wrist", "hip", "knee", "ankle")

_UPPER_ARM_PX = 90.0
_WRIST = (330.0, 470.0)
_ANKLE = (760.0, 300.0)
_HIP_FRACTION = 0.55
_SIDE_ON_LATERAL = 3.0
_FRONT_ON_LATERAL = 150.0
_BASELINE_ELBOW_DEG = 175.0
_TARGET_ELBOW_DEG = 90.0


class SyntheticPushUpSource:
    """A drawn side-on push-up, with no camera and no pose model.

    The body is the same model the push-up tests use: a rigid line pivoting about the ankles, with
    the shoulder descending toward fixed hands as the elbow bends, so ``progress`` maps to a known
    elbow angle. It exists so the setup gate, the rep machine and every rule can be watched
    behaving on a body whose ground truth is known — including faults, which are hard to perform on
    demand in front of a webcam.

    The stream deliberately opens with a still hold: the pre-check dwell and the timed baseline
    capture have to pass before any rep can be counted, and watching that happen is half the point.
    """

    def __init__(
        self,
        *,
        reps: int = 6,
        fps: int = 30,
        hold_ms: float = 7000.0,
        rep_ms: float = 2200.0,
        pause_ms: float = 700.0,
        fault: Optional[str] = None,
        fault_from_rep: int = 3,
        size: tuple[int, int] = (1024, 576),
    ) -> None:
        self.reps = reps
        self.fps = fps
        self.hold_ms = hold_ms
        self.rep_ms = rep_ms
        self.pause_ms = pause_ms
        self.fault = fault
        self.fault_from_rep = fault_from_rep
        self.size = size
        self.native_fps = float(fps)

    def frames(self) -> Iterator[Frame]:
        step_ms = 1000.0 / self.fps
        total_ms = self.hold_ms + self.reps * (self.rep_ms + self.pause_ms) + 1500.0
        t_ms = 0.0
        while t_ms <= total_ms:
            progress, rep_index = self._schedule(t_ms)
            faulting = self.fault is not None and rep_index >= self.fault_from_rep
            sag = 0.0
            lateral = _SIDE_ON_LATERAL
            if faulting and self.fault == "sag":
                sag = 0.085 * progress
            elif faulting and self.fault == "pike":
                sag = -0.085 * progress
            elif faulting and self.fault == "frontal":
                lateral = _FRONT_ON_LATERAL

            keypoints = _synthetic_keypoints(progress, sag=sag, lateral=lateral)
            image = _draw_synthetic(keypoints, self.size, progress, rep_index)
            yield Frame(image=image, keypoints=keypoints, t_ms=t_ms)
            t_ms += step_ms

    def _schedule(self, t_ms: float) -> tuple[float, int]:
        """Progress at this instant, and which rep we are in (0 during the opening hold)."""
        if t_ms < self.hold_ms:
            return 0.0, 0
        cycle = self.rep_ms + self.pause_ms
        elapsed = t_ms - self.hold_ms
        rep_index = int(elapsed // cycle) + 1
        within = elapsed % cycle
        if within >= self.rep_ms:
            return 0.0, rep_index
        # One smooth down-and-up, so descent, bottom and ascent all get real dwell.
        phase = within / self.rep_ms
        return math.sin(math.pi * phase) ** 0.9, rep_index


def _synthetic_keypoints(
    progress: float,
    *,
    sag: float = 0.0,
    lateral: float = _SIDE_ON_LATERAL,
    visibility: float = 0.95,
) -> dict:
    angle = _BASELINE_ELBOW_DEG - progress * (_BASELINE_ELBOW_DEG - _TARGET_ELBOW_DEG)
    reach = 2.0 * _UPPER_ARM_PX * math.sin(math.radians(angle / 2.0))
    shoulder = (_WRIST[0], _WRIST[1] - reach)
    elbow = _two_segment_elbow(shoulder, _WRIST)
    hip = _hip_point(shoulder, sag)
    knee = ((hip[0] + _ANKLE[0]) / 2.0, (hip[1] + _ANKLE[1]) / 2.0)

    near = {
        "shoulder": shoulder,
        "elbow": elbow,
        "wrist": _WRIST,
        "hip": hip,
        "knee": knee,
        "ankle": _ANKLE,
    }
    keypoints: dict[str, dict[str, float]] = {}
    for joint, point in near.items():
        keypoints[f"left_{joint}"] = {"x": point[0], "y": point[1], "v": visibility}
        keypoints[f"right_{joint}"] = {
            "x": point[0] + lateral,
            "y": point[1],
            "v": max(0.0, visibility - 0.25),
        }

    # Head, forward of the shoulders along the body axis — drawn, never measured.
    axis = (shoulder[0] - _ANKLE[0], shoulder[1] - _ANKLE[1])
    length = math.hypot(*axis) or 1.0
    unit = (axis[0] / length, axis[1] / length)
    nose = (shoulder[0] + unit[0] * 70.0, shoulder[1] + unit[1] * 70.0)
    for name in ("nose", "left_ear", "right_ear"):
        keypoints[name] = {"x": nose[0], "y": nose[1], "v": visibility}
    return keypoints


def _two_segment_elbow(shoulder: tuple[float, float], wrist: tuple[float, float]):
    axis = (wrist[0] - shoulder[0], wrist[1] - shoulder[1])
    span = math.hypot(*axis) or 1.0
    half = span / 2.0
    height = math.sqrt(max(0.0, _UPPER_ARM_PX**2 - half**2))
    unit = (axis[0] / span, axis[1] / span)
    normal = (-unit[1], unit[0])
    if normal[0] < 0.0:  # bend toward the feet
        normal = (-normal[0], -normal[1])
    middle = ((shoulder[0] + wrist[0]) / 2.0, (shoulder[1] + wrist[1]) / 2.0)
    return (middle[0] + normal[0] * height, middle[1] + normal[1] * height)


def _hip_point(shoulder: tuple[float, float], sag: float):
    axis = (shoulder[0] - _ANKLE[0], shoulder[1] - _ANKLE[1])
    span = math.hypot(*axis) or 1.0
    on_line = (_ANKLE[0] + axis[0] * _HIP_FRACTION, _ANKLE[1] + axis[1] * _HIP_FRACTION)
    if sag == 0.0:
        return on_line
    unit = (axis[0] / span, axis[1] / span)
    normal = (-unit[1], unit[0])
    if normal[1] < 0.0:  # positive sag moves the hip toward the floor
        normal = (-normal[0], -normal[1])
    return (on_line[0] + normal[0] * sag * span, on_line[1] + normal[1] * sag * span)


_SYNTH_BONES = (
    ("nose", "left_shoulder"),
    ("left_shoulder", "left_elbow"),
    ("left_elbow", "left_wrist"),
    ("left_shoulder", "left_hip"),
    ("left_hip", "left_knee"),
    ("left_knee", "left_ankle"),
)


def _draw_synthetic(
    keypoints: dict,
    size: tuple[int, int],
    progress: float,
    rep_index: int,
) -> np.ndarray:
    """Render the synthetic body so there is something to look at behind the overlay."""
    width, height = size
    image = np.full((height, width, 3), (26, 24, 22), dtype=np.uint8)
    floor_y = int(_WRIST[1] + 24)
    cv2.line(image, (0, floor_y), (width, floor_y), (60, 58, 54), 3)
    for first, second in _SYNTH_BONES:
        start = keypoints.get(first)
        end = keypoints.get(second)
        if start and end:
            cv2.line(
                image,
                (int(start["x"]), int(start["y"])),
                (int(end["x"]), int(end["y"])),
                (150, 170, 185),
                8,
                cv2.LINE_AA,
            )
    for name, point in keypoints.items():
        if name.startswith("left_") or name == "nose":
            cv2.circle(
                image, (int(point["x"]), int(point["y"])), 7, (215, 225, 235), -1, cv2.LINE_AA
            )
    return image
