"""Push-up depth rule — the exercise's range-of-motion signal + full/shallow gate.

One biomechanical rule kernel (template id `pushup_depth`, "Short depth"), standing completely on
its own: no rep FSM, no phase machine, no rep counting. From a single frame's shoulder + elbow +
wrist it answers:

    1. HOW FAR DOWN is the push-up right now?  → a normalized `progress` signal
    2. Is that deep enough for a FULL rep?      → the `is_full_depth()` gate

Division of responsibility, identical to squat `depth` and curl `curl_rom`:
    • This rule owns WHAT "full depth" means and how depth is measured.
    • The generic RepFSM owns WHEN — it tracks each rep's PEAK progress and asks this rule
      `is_full_depth(peak)`. A rep is SHALLOW when that is False while the peak still cleared the
      FSM's `min_rep_peak`; below that it is a diagnostic invalid attempt.

THE MEASUREMENT — elbow flexion against the person's own captured plank:

    progress = (baseline_elbow_angle - elbow_angle) / (baseline_elbow_angle - target_elbow_angle)

        0.0  = the elbow is as straight as this person's CAPTURED top position
        1.0  = the elbow has closed to `target_elbow_angle_deg` (90 deg, the coaching definition)
        >1.0 = deeper than the target (kept raw, not clamped, so the FSM sees the true peak)
        <0.0 = straighter than the captured top (kept raw)

    Angles are already scale-free, so unlike the squat and curl signals this one needs no pixel
    normalization; the only pixel quantity used is an upper-arm length, as a "close enough to the
    camera to trust" floor. Taking the extended angle from the BASELINE rather than assuming 180 deg
    is what stops a person who cannot fully lock out from being permanently scored shallow.

WHY THIS NEEDS THE SIDE-ON VIEW: front-on, the forearm points at the camera and the projected
shoulder-elbow-wrist angle collapses — the same foreshortening that moved bicep_curl's ROM off elbow
angle onto wrist height. A push-up has no comparable vertical travel to substitute, so the profile
view is a requirement rather than a preference, enforced by `side_view_orientation`.

ONE SIDE AT A TIME: in profile the far arm is occluded, so the rule measures whichever arm the frame
tracks (see kinematics.analysis_side) and reports which one it used. Both arms move together in a
push-up, so unlike a double-arm curl there is no weaker-side reduction to make here.

Thresholds are NOT hardcoded: `target_elbow_angle_deg`, `full_rom_gate` and both degeneracy floors
come from the template. Ported from the standalone service's PUSHUP elbow-angle signal
(pose_backend/exercises/pushup.py).
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.core.keypoints import reference_xy, usable_xy
from backend.workouts.pushup.kinematics import (
    distance,
    joint_angle,
    usable_side,
)

RULE_ID = "pushup_depth"
#: Joint chain this rule reads, per side.
JOINTS = ("shoulder", "elbow", "wrist")
#: Anatomical inputs are stable kernel metadata; thresholds remain in configuration. Both sides are
#: declared because either may be the camera-facing one.
REQUIRED_KEYPOINTS = (
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
)


@dataclass(frozen=True)
class PushUpDepthReading:
    """One frame's depth read. `progress` is raw and unrounded — the rep machine compares peaks
    against the gate, so precision matters; presentation rounding is a caller concern."""

    progress: float          # 0.0 at the captured top → 1.0 at the target elbow angle (>1 deeper)
    elbow_angle_deg: float   # the measured interior shoulder-elbow-wrist angle
    side: str                # which arm this frame was measured from ("left" / "right")
    full_rom_gate: float     # the sole full-ROM boundary, from configuration
    full_depth: bool         # did THIS frame reach the gate
    shortfall: float | None  # distance below the gate; None when at/over it


class PushUpDepthRule:
    """Per-frame push-up depth. Construction fixes the reference (the captured plank) and the gate.

    Args:
        baseline: persisted per-set baseline keypoints (the held top position).
        target_elbow_angle_deg: the elbow angle that counts as progress 1.0.
        full_rom_gate: the sole full-rep credit point, applied to a rep's peak progress.
        min_baseline_elbow_angle_deg: reject a baseline captured with bent arms.
        min_upper_arm_px: reject a baseline taken too far from the camera to measure.

    Raises ValueError when neither arm yields a usable baseline — the adapter catches it and runs no
    depth analysis rather than emitting nonsense.
    """

    required_keypoints = REQUIRED_KEYPOINTS

    def __init__(
        self,
        baseline: dict,
        *,
        target_elbow_angle_deg: float,
        full_rom_gate: float,
        min_baseline_elbow_angle_deg: float,
        min_upper_arm_px: float,
    ) -> None:
        target = float(target_elbow_angle_deg)
        gate = float(full_rom_gate)
        minimum_angle = float(min_baseline_elbow_angle_deg)
        minimum_arm = float(min_upper_arm_px)
        if not gate > 0.0:
            raise ValueError(f"full ROM gate must be positive, got {gate}")
        if not minimum_angle > target:
            raise ValueError(
                "min_baseline_elbow_angle_deg must exceed target_elbow_angle_deg, or the signal "
                f"has no range: {minimum_angle} vs {target}"
            )

        self._target = target
        self._full_rom_gate = gate
        # Per-side baselines: in profile only one arm is reliably visible, and which one depends on
        # the way the user happens to face, so both are resolved up front and the live frame picks.
        self._baseline_angles: dict[str, float] = {}
        for side in ("left", "right"):
            angle = _baseline_arm(baseline, side, minimum_angle, minimum_arm)
            if angle is not None:
                self._baseline_angles[side] = angle
        if not self._baseline_angles:
            raise ValueError(
                "push-up depth needs one arm captured extended (elbow angle >= "
                f"{minimum_angle:.0f} deg, upper arm >= {minimum_arm:.0f}px); "
                "recapture the baseline at the top of a push-up"
            )

    def read(self, keypoints: dict) -> PushUpDepthReading | None:
        """Compute this frame's depth from the live shoulder + elbow + wrist landmarks.

        Returns None when neither arm is fully present above CONFIDENCE_MIN — a low-confidence joint
        carries jitter that would corrupt the signal, so the caller must treat the frame as "no
        reading" and never advance a rep or score on it.
        """
        resolved = usable_side(
            keypoints, JOINTS, usable_xy, allowed=tuple(self._baseline_angles)
        )
        if resolved is None:
            return None
        side, points = resolved
        elbow_angle = joint_angle(points["shoulder"], points["elbow"], points["wrist"])
        if elbow_angle is None:
            return None

        baseline_angle = self._baseline_angles[side]
        progress = (baseline_angle - elbow_angle) / (baseline_angle - self._target)
        return PushUpDepthReading(
            progress=progress,
            elbow_angle_deg=round(elbow_angle, 3),
            side=side,
            full_rom_gate=self._full_rom_gate,
            full_depth=self.is_full_depth(progress),
            shortfall=(
                round(self._full_rom_gate - progress, 3)
                if progress < self._full_rom_gate
                else None
            ),
        )

    def is_full_depth(self, progress: float) -> bool:
        """The gate: True once progress reaches the configured boundary.

        Applied to a rep's PEAK progress — peak < gate ⇒ SHALLOW. The single definition of a
        full-depth push-up, so the per-frame `full_depth` and the per-rep verdict cannot disagree.
        """
        return progress >= self._full_rom_gate

    @property
    def full_rom_gate(self) -> float:
        return self._full_rom_gate

    @property
    def target_elbow_angle_deg(self) -> float:
        """The elbow angle that defines progress 1.0 — the signal's scale."""
        return self._target

    @property
    def baseline_elbow_angles_deg(self) -> dict[str, float]:
        """Captured extended elbow angle per usable side — the signal's zero point.

        Exposed for capture metadata: configuration alone does not determine this signal, the
        baseline does.
        """
        return dict(self._baseline_angles)

    def reset(self) -> None:
        """Stateless rule compatibility hook."""


def _baseline_arm(
    baseline: dict,
    side: str,
    minimum_angle: float,
    minimum_arm_px: float,
) -> float | None:
    """The captured extended elbow angle for one side, or None if it is not usable."""
    points = reference_xy(
        baseline, tuple(f"{side}_{joint}" for joint in JOINTS)
    )
    if points is None:
        return None
    shoulder = points[f"{side}_shoulder"]
    elbow = points[f"{side}_elbow"]
    wrist = points[f"{side}_wrist"]
    if distance(shoulder, elbow) < minimum_arm_px:
        return None
    angle = joint_angle(shoulder, elbow, wrist)
    if angle is None or angle < minimum_angle:
        return None
    return angle
