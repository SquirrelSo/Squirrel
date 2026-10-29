"""High Knee range-of-motion signal for independent left and right knee drives.

The rule is deliberately measurement-only. It does not decide when a lift starts or ends and it
does not count cycles; the independent per-leg FSMs introduced in Phase 5 will consume the raw
signals produced here.

For each side::

    baseline_gap = projection(baseline_hip - baseline_knee, baseline_body_up)
    live_gap     = projection(live_hip - live_knee, live_body_up)
    progress     = 1 - live_gap / baseline_gap

Zero is the captured standing knee height and one is knee-at-hip height. The live same-side hip
removes whole-image translation and vertical body bounce, while the live body-up axis makes the
projection invariant to rigid image rotation. Raw values stay unclamped for later FSM/replay use;
display values alone are clamped to [0, 1].

Only the hips and knees are required live. The live gap is rescaled by live torso length over
the baseline's, so standing closer to or further from the camera than at setup changes nothing.
Without usable shoulders (out of frame) the image vertical is the up axis and no rescaling is
applied: the reading carries on rather than stopping. Neither case may stop a lift from counting.

Availability is per side. A missing/low-confidence knee suppresses only that leg, but unusable
hips suppress both. A live hip-knee vector is allowed to approach zero: in
a front view that can be a legitimate hip-height knee drive, not necessarily corrupt geometry.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot, isfinite

from backend.core.keypoints import reference_xy, usable_xy

RULE_ID = "knee_drive_rom"
REQUIRED_KEYPOINTS = (
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
)
# The setup baseline also fixes the torso scale and axis.
BASELINE_KEYPOINTS = ("left_shoulder", "right_shoulder") + REQUIRED_KEYPOINTS

_HIP_KEYPOINTS = ("left_hip", "right_hip")
_SHOULDER_KEYPOINTS = ("left_shoulder", "right_shoulder")
_IMAGE_UP = (0.0, -1.0)
_SIDES = ("left", "right")


@dataclass(frozen=True)
class KneeDriveReading:
    """One frame's independent raw and presentation-safe knee-drive signals."""

    left_progress_raw: float | None
    right_progress_raw: float | None
    left_progress_display: float | None
    right_progress_display: float | None
    left_available: bool
    right_available: bool


class KneeDriveRomRule:
    """Convert live front-view landmarks into baseline-relative per-leg ROM progress."""

    def __init__(
        self,
        baseline: dict,
        full_rom_gate: float,
        *,
        min_baseline_gap_px: float,
        min_torso_length_px: float,
    ) -> None:
        for value, label in (
            (full_rom_gate, "full ROM gate"),
            (min_baseline_gap_px, "minimum baseline hip-knee gap"),
            (min_torso_length_px, "minimum torso length"),
        ):
            if not isfinite(value) or value <= 0.0:
                raise ValueError(f"{label} must be finite and positive, got {value}")

        points = reference_xy(baseline, BASELINE_KEYPOINTS)
        if points is None:
            raise ValueError(
                "High Knee baseline requires finite shoulder, hip and knee coordinates"
            )
        body_frame = _body_frame(points, min_torso_length_px)
        if body_frame is None:
            raise ValueError(
                "High Knee baseline torso axis is below the configured minimum length"
            )
        up_axis, torso_length = body_frame

        baseline_gaps: dict[str, float] = {}
        for side in _SIDES:
            gap = _projection(
                _subtract(points[f"{side}_hip"], points[f"{side}_knee"]),
                up_axis,
            )
            if not isfinite(gap) or gap < min_baseline_gap_px:
                raise ValueError(
                    f"baseline {side} hip-to-knee projected gap ({gap:.1f}px) is below the "
                    f"minimum plausible {min_baseline_gap_px}px; recapture standing upright"
                )
            baseline_gaps[side] = gap

        self._baseline_gaps = baseline_gaps
        self._baseline_torso_length = torso_length
        self._full_rom_gate = float(full_rom_gate)
        self._min_torso_length_px = float(min_torso_length_px)

    def read(self, keypoints: dict) -> KneeDriveReading:
        """Read both legs, preserving independent knee availability.

        Unusable hips return an unavailable reading for both sides. Otherwise, each knee is
        confidence-gated independently and the usable side remains available.
        """
        common = usable_xy(keypoints, _HIP_KEYPOINTS)
        if common is None or not _landmarks_finite(keypoints, _HIP_KEYPOINTS):
            return _unavailable_reading()
        up_axis, scale = _IMAGE_UP, 1.0
        shoulders = usable_xy(keypoints, _SHOULDER_KEYPOINTS)
        if shoulders is not None and _landmarks_finite(keypoints, _SHOULDER_KEYPOINTS):
            body_frame = _body_frame({**common, **shoulders}, self._min_torso_length_px)
            if body_frame is not None:
                up_axis, torso_length = body_frame
                scale = torso_length / self._baseline_torso_length

        raw: dict[str, float | None] = {}
        available: dict[str, bool] = {}
        for side in _SIDES:
            knee = usable_xy(keypoints, (f"{side}_knee",))
            if knee is None or not _landmarks_finite(keypoints, (f"{side}_knee",)):
                raw[side] = None
                available[side] = False
                continue
            live_gap = _projection(
                _subtract(common[f"{side}_hip"], knee[f"{side}_knee"]),
                up_axis,
            )
            progress = 1.0 - live_gap / scale / self._baseline_gaps[side]
            if not isfinite(progress):
                raw[side] = None
                available[side] = False
                continue
            raw[side] = progress
            available[side] = True

        return KneeDriveReading(
            left_progress_raw=raw["left"],
            right_progress_raw=raw["right"],
            left_progress_display=_display(raw["left"]),
            right_progress_display=_display(raw["right"]),
            left_available=available["left"],
            right_available=available["right"],
        )

    def is_full_rom(self, progress: float) -> bool:
        """Return whether a leg's peak raw progress reaches the configured ROM gate."""
        return isfinite(progress) and progress >= self._full_rom_gate

    @property
    def full_rom_gate(self) -> float:
        return self._full_rom_gate

    def baseline_gap_px(self, side: str) -> float:
        """Expose the captured signal denominator for offline rig diagnosis."""
        if side not in _SIDES:
            raise ValueError(f"side must be one of {_SIDES}, got {side!r}")
        return self._baseline_gaps[side]


def _body_frame(
    points: dict[str, tuple[float, float]],
    min_torso_length_px: float,
) -> tuple[tuple[float, float], float] | None:
    """The torso's up axis and length (hips to shoulders), or None below the length floor."""
    shoulder_mid = _midpoint(points["left_shoulder"], points["right_shoulder"])
    hip_mid = _midpoint(points["left_hip"], points["right_hip"])
    torso = _subtract(shoulder_mid, hip_mid)
    length = hypot(*torso)
    if not isfinite(length) or length < min_torso_length_px:
        return None
    return (torso[0] / length, torso[1] / length), length


def _unavailable_reading() -> KneeDriveReading:
    return KneeDriveReading(None, None, None, None, False, False)


def _display(progress: float | None) -> float | None:
    return None if progress is None else min(1.0, max(0.0, progress))


def _landmarks_finite(keypoints: dict, names: tuple[str, ...]) -> bool:
    """Close the generic helper's NaN visibility gap locally without changing other exercises."""
    return all(
        isfinite(float(keypoints[name][field]))
        for name in names
        for field in ("x", "y", "v")
    )


def _projection(vector: tuple[float, float], axis: tuple[float, float]) -> float:
    return vector[0] * axis[0] + vector[1] * axis[1]


def _subtract(
    first: tuple[float, float],
    second: tuple[float, float],
) -> tuple[float, float]:
    return (first[0] - second[0], first[1] - second[1])


def _midpoint(
    first: tuple[float, float],
    second: tuple[float, float],
) -> tuple[float, float]:
    return ((first[0] + second[0]) / 2.0, (first[1] + second[1]) / 2.0)
