"""Synthetic SIDE-ON push-up frames for the push-up rule and adapter tests.

Not a test module (no ``test_`` prefix, so pytest does not collect it) — it is the shared body model
the push-up tests drive, in the same spirit as the per-file keypoint builders the squat, curl and
high-knee tests use, factored out because five test modules need the same geometry.

THE MODEL. A person in profile, hands planted on the floor, body a rigid straight line pivoting about
the ankles. Coordinates are pixels with y growing downward, exactly as the browser sends them.

    * ``progress`` drives the elbow: the arm is two equal segments from shoulder to wrist, so a
      target elbow angle fixes the shoulder-to-wrist distance (d = 2 L sin(theta/2)) and the shoulder
      descends toward the fixed hands as the elbow bends. progress 0.0 is the captured top
      (``BASELINE_ELBOW_DEG``), progress 1.0 is ``TARGET_ELBOW_DEG`` — matching the template.
    * The hip is placed ON the shoulder-to-ankle line, so a default frame has a perfectly straight
      body. ``sag`` displaces it perpendicular to that line: positive toward the floor (sag),
      negative away (pike), in units of the body span — the same scale the rule reports.
    * ``lateral`` is how far the far-side landmarks sit from the near-side ones in x. Small is the
      side-on view being modelled; large simulates a user who has turned to face the camera.
"""

from __future__ import annotations

from math import hypot, radians, sin

from backend.core.frame import TrainingFrame

#: Elbow angle held at the top of the push-up, i.e. the captured baseline.
BASELINE_ELBOW_DEG = 175.0
#: The template's depth target: progress 1.0.
TARGET_ELBOW_DEG = 90.0

_UPPER_ARM_PX = 70.0
_WRIST = (300.0, 430.0)
_ANKLE = (620.0, 300.0)
#: Where the hip sits along the ankle-to-shoulder line (0 = ankle, 1 = shoulder).
_HIP_FRACTION = 0.55
#: Side-on: the far shoulder/hip/ankle project within a couple of pixels of the near ones.
_SIDE_ON_LATERAL_PX = 2.0
#: Front-on: the two sides separate by roughly a shoulder width.
FRONT_ON_LATERAL_PX = 120.0


def elbow_angle_for(progress: float) -> float:
    """The elbow angle a given progress corresponds to, by the template's definition."""
    return BASELINE_ELBOW_DEG - progress * (BASELINE_ELBOW_DEG - TARGET_ELBOW_DEG)


def keypoints(
    progress: float = 0.0,
    *,
    sag: float = 0.0,
    lateral: float = _SIDE_ON_LATERAL_PX,
    v: float = 0.9,
    far_v: float | None = None,
) -> dict:
    """One synthetic side-on push-up frame.

    ``far_v`` defaults to a little under the near side's visibility, which is what a profile view
    looks like to a pose model and what makes the near side the analysed one.
    """
    angle = elbow_angle_for(progress)
    reach = 2.0 * _UPPER_ARM_PX * sin(radians(angle / 2.0))
    shoulder = (_WRIST[0], _WRIST[1] - reach)
    elbow = _elbow(shoulder, _WRIST)
    hip = _hip(shoulder, sag)

    near = {
        "shoulder": shoulder,
        "elbow": elbow,
        "wrist": _WRIST,
        "hip": hip,
        "ankle": _ANKLE,
    }
    far_visibility = v - 0.25 if far_v is None else far_v
    frame: dict[str, dict[str, float]] = {}
    for joint, point in near.items():
        frame[f"left_{joint}"] = {"x": point[0], "y": point[1], "v": v}
        frame[f"right_{joint}"] = {
            "x": point[0] + lateral,
            "y": point[1],
            "v": far_visibility,
        }
    return frame


def baseline(progress: float = 0.0, **options) -> dict:
    """The persisted baseline: stored geometry with no visibility, as the capture writes it.

    ``progress`` defaults to the top of the push-up, which is where a baseline is supposed to be
    captured; passing a mid-rep progress models a capture taken with bent arms.
    """
    return {
        name: {axis: value for axis, value in landmark.items() if axis != "v"}
        for name, landmark in keypoints(progress, **options).items()
    }


def frame(progress: float, timestamp: float, **options) -> TrainingFrame:
    return TrainingFrame(timestamp, keypoints(progress, **options))


def _elbow(shoulder: tuple[float, float], wrist: tuple[float, float]) -> tuple[float, float]:
    """Place the elbow so the arm is two equal segments, bending toward the feet (+x)."""
    axis = (wrist[0] - shoulder[0], wrist[1] - shoulder[1])
    span = hypot(*axis)
    half = span / 2.0
    # Perpendicular offset that makes both segments _UPPER_ARM_PX long.
    height_squared = max(0.0, _UPPER_ARM_PX**2 - half**2)
    height = height_squared**0.5
    unit = (axis[0] / span, axis[1] / span)
    normal = (-unit[1], unit[0])
    if normal[0] < 0.0:  # bend toward the feet, not past the head
        normal = (-normal[0], -normal[1])
    middle = ((shoulder[0] + wrist[0]) / 2.0, (shoulder[1] + wrist[1]) / 2.0)
    return (middle[0] + normal[0] * height, middle[1] + normal[1] * height)


def _hip(shoulder: tuple[float, float], sag: float) -> tuple[float, float]:
    """Hip on the ankle-to-shoulder line, then displaced perpendicular by ``sag`` body spans."""
    axis = (shoulder[0] - _ANKLE[0], shoulder[1] - _ANKLE[1])
    span = hypot(*axis)
    on_line = (
        _ANKLE[0] + axis[0] * _HIP_FRACTION,
        _ANKLE[1] + axis[1] * _HIP_FRACTION,
    )
    if sag == 0.0:
        return on_line
    unit = (axis[0] / span, axis[1] / span)
    normal = (-unit[1], unit[0])
    if normal[1] < 0.0:  # positive sag must move the hip DOWN the image, toward the floor
        normal = (-normal[0], -normal[1])
    return (on_line[0] + normal[0] * sag * span, on_line[1] + normal[1] * sag * span)


#: Rep shapes in progress space, mirroring the squat/curl fixtures. The gate is 0.90 and
#: min_rep_peak is 0.30, so these are a full rep, a shallow one and a twitch.
FULL = [(0.0, 0), (0.3, 100), (0.6, 200), (0.9, 300), (0.95, 400), (0.9, 500), (0.7, 600), (0.3, 700), (0.05, 800)]
SHALLOW = [(0.0, 0), (0.3, 100), (0.6, 200), (0.7, 300), (0.5, 400), (0.3, 500), (0.05, 600)]
INVALID = [(0.0, 0), (0.28, 100), (0.35, 200), (0.3, 300), (0.27, 400), (0.05, 500)]
