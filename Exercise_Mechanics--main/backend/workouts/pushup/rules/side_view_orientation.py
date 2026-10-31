"""Side-on camera check — the rule that makes the push-up's camera requirement enforced, not assumed.

Every push-up measurement (depth and body line alike) is only valid in the sagittal plane, so this
kernel answers one question from a single frame's shoulders + hips: IS THE CAMERA SEEING THIS BODY
FROM THE SIDE?

THE MEASUREMENT — shoulder and hip spread, normalized by torso length:

    spread = max(|x_left_shoulder - x_right_shoulder|, |x_left_hip - x_right_hip|) / torso_length

    Seen from the side, the left and right shoulders sit almost on top of each other in the image
    (they are separated along the camera axis, not across it), so the ratio is small — around 0.10 in
    practice. Seen front-on, the same separation is close to full shoulder width and the ratio is
    several times larger. Dividing by torso length (shoulder midpoint to hip midpoint) makes the
    reading independent of how far the user stands from the camera, and taking the worse of the two
    ratios means a user who has squared their shoulders OR their hips is caught either way.

    This holds for a push-up specifically, even though the torso is horizontal: the
    shoulder-to-shoulder axis still points toward the camera in profile, which is what the ratio
    measures.

WHY IT IS A MONITOR, NOT A PENALTY: a front-on camera is not a fault in the user's form — it means
the measurements cannot be trusted. It therefore cues the user ("turn your side to the camera") and
contributes nothing to any score. It is also the one template active in all three contexts and in
every phase: the camera angle has to be right before the set starts AND stay right, because a user
rotating a few degrees between reps silently corrupts both live signals.

THE FAR SIDE MAY BE HIDDEN: side-on, the far shoulder and hip are behind the near ones, and the
pose model reports them as predictions below the confidence floor. That is the view this check
asks for, so it must not refuse to measure it: when one side's shoulder AND hip are confidently
tracked, the spread is measured from all four positions (the hidden ones as predicted), and
`far_side_hidden` says so. Only when neither side's shoulder and hip are tracked is there no reading.

FRAME HYSTERESIS: the raw band is debounced over consecutive frames (`confirm_frames` to raise,
`clear_frames` to clear) so a single noisy frame neither tells a correctly placed user to reposition
nor clears a genuinely front-on setup. Hysteresis is switched OFF for the setup adapter, which needs
an immediate per-frame verdict because the setup flow applies its own `stable_ms` dwell on top.

Ported from the standalone service's orientation check
(pose_backend/validation.py: check_orientation + FrameValidator hysteresis). Two separate constants
there (0.38 shoulders, 0.34 hips) are consolidated into one range table here; see templates.yaml for
why that is deliberate.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.core.keypoints import reference_xy, usable_xy
from backend.engine.range_policy import NumericRangePolicy
from backend.workouts.pushup.kinematics import distance, midpoint

RULE_ID = "side_view_orientation"
REQUIRED_KEYPOINTS = ("left_shoulder", "right_shoulder", "left_hip", "right_hip")
SIGNAL_MODE = "torso_normalized_spread"


@dataclass(frozen=True)
class SideViewReading:
    #: The classified signal: the worse of the two spread ratios.
    spread_ratio: float
    shoulder_spread_ratio: float
    hip_spread_ratio: float
    torso_length_px: float
    #: This frame's raw band, before hysteresis ("safe" / "warning" / "not_ok").
    state: str
    skeleton_color: str
    #: The debounced verdict the UI acts on. With hysteresis enabled this can lag `state` by a few
    #: frames in either direction — that lag is the point.
    not_ok: bool
    side: str | None
    #: A far-side shoulder or hip was below the confidence floor (measured as predicted).
    far_side_hidden: bool = False


class SideViewOrientationRule:
    """Classify the torso-normalized spread with a YAML-owned range table, plus frame hysteresis.

    Args:
        ranges: the range table from the template.
        min_torso_length_px: below this the ratios are meaningless (user too far away or cropped).
        confirm_frames: consecutive not_ok frames before the verdict is raised.
        clear_frames: consecutive non-not_ok frames before a raised verdict clears.
        hysteresis: False makes every read an immediate per-frame verdict (setup contexts).
    """

    required_keypoints = REQUIRED_KEYPOINTS

    def __init__(
        self,
        ranges: object,
        *,
        min_torso_length_px: float,
        confirm_frames: int = 1,
        clear_frames: int = 1,
        hysteresis: bool = True,
    ) -> None:
        if confirm_frames < 1 or clear_frames < 1:
            raise ValueError("confirm_frames and clear_frames must be >= 1")
        self._policy = NumericRangePolicy(ranges)
        self._min_torso = float(min_torso_length_px)
        self._confirm_frames = int(confirm_frames)
        self._clear_frames = int(clear_frames)
        self._hysteresis = bool(hysteresis)
        self._bad_frames = 0
        self._good_frames = 0
        self._flagged = False

    def read(self, keypoints: dict) -> SideViewReading | None:
        """Classify one live frame. None unless one side's shoulder and hip are confidently tracked."""
        points = usable_xy(keypoints, REQUIRED_KEYPOINTS)
        if points is not None:
            return self._evaluate(points)
        near_side = any(
            usable_xy(keypoints, (f"{side}_shoulder", f"{side}_hip")) is not None
            for side in ("left", "right")
        )
        predicted = reference_xy(keypoints, REQUIRED_KEYPOINTS)
        if not near_side or predicted is None:
            return None
        return self._evaluate(predicted, far_side_hidden=True)

    def read_reference(self, keypoints: dict) -> SideViewReading | None:
        """Classify a persisted baseline, which stores geometry without visibility."""
        return self._evaluate(reference_xy(keypoints, REQUIRED_KEYPOINTS))

    def _evaluate(
        self,
        points: dict[str, tuple[float, float]] | None,
        *,
        far_side_hidden: bool = False,
    ) -> SideViewReading | None:
        if points is None:
            return None
        shoulder_mid = midpoint(points["left_shoulder"], points["right_shoulder"])
        hip_mid = midpoint(points["left_hip"], points["right_hip"])
        torso_length = distance(shoulder_mid, hip_mid)
        if torso_length < self._min_torso:
            # Degenerate reference: a ratio against a near-zero torso says nothing. Treated as no
            # reading rather than as a front-on verdict — the framing gate is what catches this.
            return None

        shoulder_ratio = (
            abs(points["left_shoulder"][0] - points["right_shoulder"][0]) / torso_length
        )
        hip_ratio = abs(points["left_hip"][0] - points["right_hip"][0]) / torso_length
        spread = max(shoulder_ratio, hip_ratio)
        matched = self._policy.classify(spread)
        return SideViewReading(
            spread_ratio=round(spread, 5),
            shoulder_spread_ratio=round(shoulder_ratio, 5),
            hip_spread_ratio=round(hip_ratio, 5),
            torso_length_px=round(torso_length, 3),
            state=matched.state,
            skeleton_color=matched.skeleton_color,
            not_ok=self._debounce(matched.state == "not_ok"),
            side=matched.side,
            far_side_hidden=far_side_hidden,
        )

    def _debounce(self, raw_not_ok: bool) -> bool:
        if not self._hysteresis:
            return raw_not_ok
        if raw_not_ok:
            self._bad_frames += 1
            self._good_frames = 0
            if self._bad_frames >= self._confirm_frames:
                self._flagged = True
        else:
            self._good_frames += 1
            self._bad_frames = 0
            if self._flagged and self._good_frames >= self._clear_frames:
                self._flagged = False
        return self._flagged

    def reset(self) -> None:
        """Drop the hysteresis counters (a new set starts with no history)."""
        self._bad_frames = 0
        self._good_frames = 0
        self._flagged = False
