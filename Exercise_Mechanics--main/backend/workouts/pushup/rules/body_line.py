"""Push-up body-line rule — sagging or piked hips, measured in the sagittal plane.

One biomechanical rule kernel (template id `body_line`, "Body line"). It answers one question from a
single frame's shoulder + hip + ankle: HOW FAR HAS THE HIP LEFT THE STRAIGHT LINE, and in which
direction — dropped toward the floor (sag) or lifted away from it (pike)?

THE MEASUREMENT — a signed, normalized offset rather than an angle:

    offset = signed_distance(hip, line(shoulder, ankle)) / |ankle - shoulder|

        0.0  = the hip sits exactly on the shoulder-to-ankle line
        > 0  = the hip is on the FLOOR side of that line  → sagging
        < 0  = the hip is on the other side               → piked

    The shoulder-hip-ankle interior angle would also detect a break in the line, but it is unsigned:
    a 160 deg reading cannot say whether the hips dropped or rose, and those two faults need opposite
    coaching. Dividing by the shoulder-to-ankle span makes the reading independent of body size and
    camera distance, exactly as squat's depth ratio does.

    The value is then taken RELATIVE TO THE CAPTURED PLANK, for the same reason
    `lateral_torso_lean` subtracts its baseline angle: it removes camera roll and a person's natural
    plank shape, so the rule measures the change during the set rather than anatomy. What stops a
    sagging BASELINE from becoming somebody's reference is `plank_ready`, which checks straightness
    in absolute terms before a capture may be accepted.

WHY THIS NEEDS THE SIDE-ON VIEW: hip sag and pike are deviations in the sagittal plane. Front-on they
happen along the camera axis and are invisible — the hip landmarks barely move in the image.

ONE SIDE AT A TIME: in profile the far leg is occluded, so the rule measures whichever
shoulder-hip-ankle chain the frame tracks (see kinematics.analysis_side).

Thresholds live entirely in the template's range table; the kernel classifies, it does not decide.
Ported from the standalone service's PUSHUP body-line angle
(pose_backend/exercises/pushup.py), with the unsigned angle replaced by this signed offset so sag and
pike can be coached apart.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.core.keypoints import reference_xy, usable_xy
from backend.engine.range_policy import NumericRangePolicy
from backend.workouts.pushup.kinematics import distance, line_offset, usable_side

RULE_ID = "body_line"
JOINTS = ("shoulder", "hip", "ankle")
REQUIRED_KEYPOINTS = (
    "left_shoulder",
    "right_shoulder",
    "left_hip",
    "right_hip",
    "left_ankle",
    "right_ankle",
)
SIGNAL_MODE = "baseline_relative_offset"


@dataclass(frozen=True)
class BodyLineSignalReading:
    """Signed change from the captured plank; positive is toward the floor (sag)."""

    offset: float
    absolute_offset: float
    body_span_px: float
    analysed_side: str


@dataclass(frozen=True)
class BodyLineReading:
    offset: float
    absolute_offset: float
    body_span_px: float
    analysed_side: str
    state: str
    skeleton_color: str
    not_ok: bool
    #: "sag" | "pike" | None — the direction the range table attributes the fault to.
    side: str | None


class BodyLineSignal:
    """Measure the hip's signed offset from the shoulder-to-ankle line, relative to the baseline.

    Per-side baselines are resolved at construction: in profile only one leg is reliably visible, and
    which one depends on the way the user faces, so the live frame picks between whichever sides
    produced a usable captured reference.
    """

    required_keypoints = REQUIRED_KEYPOINTS

    def __init__(self, baseline: dict, mode: str, *, min_body_span_px: float) -> None:
        if mode != SIGNAL_MODE:
            raise ValueError(f"unsupported body-line signal mode: {mode!r}")
        self._min_span = float(min_body_span_px)
        self._baseline_offsets: dict[str, float] = {}
        for side in ("left", "right"):
            offset = _baseline_offset(baseline, side, self._min_span)
            if offset is not None:
                self._baseline_offsets[side] = offset
        if not self._baseline_offsets:
            raise ValueError(
                "body line needs one shoulder-hip-ankle chain captured with a span of at least "
                f"{self._min_span:.0f}px; recapture the baseline with the whole body in frame"
            )

    def read(self, keypoints: dict) -> BodyLineSignalReading | None:
        resolved = usable_side(
            keypoints, JOINTS, usable_xy, allowed=tuple(self._baseline_offsets)
        )
        if resolved is None:
            return None
        side, points = resolved
        span = distance(points["shoulder"], points["ankle"])
        if span < self._min_span:
            # Too small to measure: the normalized offset would be noise.
            return None
        offset = line_offset(points["shoulder"], points["ankle"], points["hip"])
        if offset is None:
            return None
        relative = offset - self._baseline_offsets[side]
        return BodyLineSignalReading(
            offset=relative,
            absolute_offset=offset,
            body_span_px=span,
            analysed_side=side,
        )

    @property
    def baseline_offsets(self) -> dict[str, float]:
        """The captured plank offset per usable side — the signal's zero point."""
        return dict(self._baseline_offsets)


class BodyLineRule:
    """Classify the baseline-relative body-line offset with a YAML-owned range table."""

    required_keypoints = REQUIRED_KEYPOINTS

    def __init__(
        self,
        baseline: dict,
        mode: str,
        ranges: object,
        *,
        min_body_span_px: float,
    ) -> None:
        self._signal = BodyLineSignal(baseline, mode, min_body_span_px=min_body_span_px)
        self._policy = NumericRangePolicy(ranges)

    def read(self, keypoints: dict) -> BodyLineReading | None:
        signal = self._signal.read(keypoints)
        if signal is None:
            return None
        matched = self._policy.classify(signal.offset)
        return BodyLineReading(
            offset=round(signal.offset, 5),
            absolute_offset=round(signal.absolute_offset, 5),
            body_span_px=round(signal.body_span_px, 3),
            analysed_side=signal.analysed_side,
            state=matched.state,
            skeleton_color=matched.skeleton_color,
            not_ok=matched.state == "not_ok",
            side=matched.side,
        )

    @property
    def baseline_offsets(self) -> dict[str, float]:
        return self._signal.baseline_offsets

    def reset(self) -> None:
        """Stateless rule compatibility hook."""


def _baseline_offset(baseline: dict, side: str, min_span: float) -> float | None:
    """The captured hip offset for one side, or None if that chain is not usable."""
    points = reference_xy(baseline, tuple(f"{side}_{joint}" for joint in JOINTS))
    if points is None:
        return None
    shoulder = points[f"{side}_shoulder"]
    hip = points[f"{side}_hip"]
    ankle = points[f"{side}_ankle"]
    if distance(shoulder, ankle) < min_span:
        return None
    return line_offset(shoulder, ankle, hip)
