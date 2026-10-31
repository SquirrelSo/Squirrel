"""Push-up pre-check — the baseline may only be captured at the top of a real push-up.

The analogue of squat's `standing_posture`: a setup-only condition that decides whether a captured
frame is fit to become this person's reference. It is the one push-up rule that measures in ABSOLUTE
terms, and that is deliberate — the live rules are baseline-relative, so if a sagging or
half-bent-arm plank were accepted here, every later reading would be measured against a bad zero.

Three checks, all from one frame:

    arms_extended    the elbow is at least `min_elbow_extension_deg` — the top of a push-up, so the
                     captured elbow angle can serve as push-up depth's zero point.
    body_straight    |hip offset from the shoulder-to-ankle line| within `max_body_line_offset`, on
                     the same normalized scale the live body-line rule uses.
    torso_horizontal the shoulder-to-hip line is within `max_torso_deg_from_horizontal` of the image
                     horizontal. In a plank the torso is near-horizontal; this is also what separates
                     a push-up from a standing exercise, and it is the only check here that would
                     reject somebody setting up for the wrong movement entirely.

Ported from the standalone service, where the same three quantities formed the push-up classifier's
signals (pose_backend/exercises/pushup.py: torso_horizontal, body_line_straightish) — here they are a
setup gate rather than a classifier, because in Exercise Mechanics the app already knows which
exercise the user selected.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.core.keypoints import reference_xy, usable_xy
from backend.workouts.pushup.kinematics import (
    degrees_from_horizontal,
    distance,
    joint_angle,
    line_offset,
    usable_side,
)

RULE_ID = "plank_ready"
#: The per-side chain every check reads (whichever side the camera sees best). REQUIRED_KEYPOINTS
#: names both sides because either may be the one in view.
JOINTS = ("shoulder", "elbow", "wrist", "hip", "ankle")
REQUIRED_KEYPOINTS = (
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_ankle",
    "right_ankle",
)


@dataclass(frozen=True)
class PlankReadyReading:
    elbow_angle_deg: float
    body_line_offset: float
    torso_deg_from_horizontal: float
    analysed_side: str
    arms_extended: bool
    body_straight: bool
    torso_horizontal: bool
    passed: bool


class PlankReadyRule:
    required_keypoints = REQUIRED_KEYPOINTS

    def __init__(
        self,
        *,
        min_elbow_extension_deg: float,
        max_body_line_offset: float,
        max_torso_deg_from_horizontal: float,
    ) -> None:
        self._min_elbow = float(min_elbow_extension_deg)
        self._max_offset = float(max_body_line_offset)
        self._max_torso = float(max_torso_deg_from_horizontal)

    def read(self, keypoints: dict) -> PlankReadyReading | None:
        """Evaluate one live setup frame (confidence-gated)."""
        return self._evaluate(keypoints, usable_xy)

    def read_reference(self, keypoints: dict) -> PlankReadyReading | None:
        """Evaluate a persisted baseline, which stores geometry without visibility."""
        return self._evaluate(keypoints, reference_xy)

    def _evaluate(self, keypoints: dict, reader) -> PlankReadyReading | None:
        resolved = usable_side(keypoints, JOINTS, reader)
        if resolved is None:
            return None
        side, points = resolved

        elbow_angle = joint_angle(points["shoulder"], points["elbow"], points["wrist"])
        if elbow_angle is None:
            return None
        if distance(points["shoulder"], points["ankle"]) == 0.0:
            return None
        offset = line_offset(points["shoulder"], points["ankle"], points["hip"])
        if offset is None:
            return None

        # The torso angle from the analysed side's own shoulder and hip: side-on, the far side is
        # hidden behind the near one (and lies on the same line), so requiring it would refuse
        # exactly the view push-ups are measured from.
        torso_angle = degrees_from_horizontal(points["shoulder"], points["hip"])
        if torso_angle is None:
            return None

        arms_extended = elbow_angle >= self._min_elbow
        body_straight = abs(offset) <= self._max_offset
        torso_horizontal = torso_angle <= self._max_torso
        return PlankReadyReading(
            elbow_angle_deg=round(elbow_angle, 3),
            body_line_offset=round(offset, 5),
            torso_deg_from_horizontal=round(torso_angle, 3),
            analysed_side=side,
            arms_extended=arms_extended,
            body_straight=body_straight,
            torso_horizontal=torso_horizontal,
            passed=arms_extended and body_straight and torso_horizontal,
        )

    def reset(self) -> None:
        """Stateless rule compatibility hook."""
