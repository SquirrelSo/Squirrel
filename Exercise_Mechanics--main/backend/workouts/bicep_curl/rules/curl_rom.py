"""Curl ROM rule — the double-arm curl's range-of-motion signal + full/shallow gate.

This is one biomechanical rule kernel (template id `curl_rom`, "Short curl"), built to stand
completely on its own — no rep FSM, no phase machine, no rep counting. From a single frame's
shoulder + elbow + wrist landmarks it answers, for BOTH arms:

    1. HOW FAR HAS THE WRIST RISEN right now?  → a normalized per-arm `*_ratio` signal
    2. Is the rep deep enough for FULL?         → the `is_full_rom()` gate on the LEADING arm

Division of responsibility (why this is FSM-free), identical to the squat depth rule:
    • This rule owns WHAT "full curl" means (one gate) and how the curl is measured.
    • A rep machine (the generic RepFSM) owns WHEN — it tracks each rep's PEAK `progress` and asks
      this rule `is_full_rom(peak)`. A rep is flagged SHALLOW when that is False but the peak still
      cleared the FSM's `min_rep_peak`; below that it is a diagnostic invalid attempt.

The measurement (the load-bearing part) — WRIST HEIGHT, not elbow angle:

    offset  = (wrist_y − shoulder_y) / upper_arm      (same arm, live; image y grows down)
    ratio   = (rest_offset − offset) / (rest_offset − target_offset)

        0.0  = the wrist hangs where the person's BASELINE put it (arm at rest)
        1.0  = the wrist has risen to `target_offset` (0.0 ⇒ wrist level with the shoulder)
        >1.0 = risen past the target (kept raw, not clamped)
        <0.0 = below the resting hang (kept raw)

    The 2D interior elbow angle this replaced is unusable on a FRONT-view camera: foreshortening
    makes shoulder-elbow-wrist near-collinear at the top of a curl, so the angle collapses from
    ~178° to a few degrees within one frame and cannot separate a shallow curl from a full one.
    Vertical wrist travel is read cleanly by a front camera and degrades gracefully.

    `rest_offset` comes from the persisted per-set BASELINE (arms hanging extended, captured at
    setup), in upper-arm lengths. The live offset is scaled by the LIVE upper arm (shoulder→elbow),
    so stepping closer to the camera after setup (setup needs the feet in view) changes nothing.
    Each wrist is measured against its OWN live shoulder, which removes body translation and needs
    nothing below the chest: people curl close to the camera, with the hips
    out of frame, and a hip-anchored measurement read nothing at all, so no curl ever counted. (A
    shrug lifts the shoulder a little and reads as slightly less curl; it is scored separately by
    shoulder_elevation.) `z` is unreliable on a front-view camera, so this is a 2D measurement.

`progress` — the movement's headline value — is the LEADING arm, `max(left_ratio, right_ratio)`
(also reported as `leading_ratio`). A curl with either arm counts: both arms together, alternating
arms, or one arm while the other is out of view. Requiring BOTH arms (the weaker-arm `min`) meant
alternating curls, and any frame where one arm was hidden, never counted. The weaker arm is still
reported (`weaker_side`, the per-arm ratios) so coaching can name a side that curls short.

Only the shoulders are required live. Each arm is measured when its elbow and wrist are usable;
with one arm out of view, the visible arm stands in for both.

Thresholds are NOT hardcoded here. `target_offset`, `min_upper_arm_px` and `full_rom_gate` are
passed verbatim from the curl template; the curl ROM signal deliberately has no hysteresis.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot, isfinite

from backend.core.keypoints import reference_xy, usable_xy

RULE_ID = "curl_rom"
# Anatomical inputs are stable kernel metadata; thresholds remain in configuration. Order groups
# each arm's shoulder→elbow→wrist chain but is only used as a membership/visibility set.
REQUIRED_KEYPOINTS = (
    "left_shoulder",
    "right_shoulder",
)
# Per arm, optional live: a curl is read from whichever arms are usable.
_ARM_JOINTS = ("elbow", "wrist")
# The baseline (arms hanging, captured at setup) still needs both arms: it fixes each arm's scale.
BASELINE_KEYPOINTS = REQUIRED_KEYPOINTS + tuple(
    f"{side}_{joint}" for side in ("left", "right") for joint in _ARM_JOINTS
)

_SIDES = ("left", "right")
# Below this the resting hang and the target coincide: the normalization would divide by ~0 and the
# ratio would explode. A pure degeneracy floor (like a zero-length segment), not a tunable.
_MIN_REST_SPAN = 1e-6


def _side(side: str) -> str:
    if side not in _SIDES:
        raise ValueError(f"side must be one of {_SIDES}, got {side!r}")
    return side


@dataclass(frozen=True)
class CurlRomReading:
    """One frame's curl read. `progress` is the raw weaker-arm signal (unrounded — the rep machine
    compares peaks against the gate, so precision matters); presentation rounding is a caller
    concern."""

    progress: float          # max(left_ratio, right_ratio) — the leading arm; the FSM signal
    leading_ratio: float     # max(left_ratio, right_ratio) — the arm furthest through the curl
    left_ratio: float        # 0.0 at the baseline hang → 1.0 at the target height (>1 beyond it)
    right_ratio: float
    left_offset: float       # raw normalized wrist offset below the baseline shoulder target
    right_offset: float
    full_rom_gate: float      # the sole full-ROM boundary from exercise config
    full_rom: bool            # did the leading arm reach the gate (progress ≥ gate)
    left_full: bool           # did the left arm alone reach the gate
    right_full: bool          # did the right arm alone reach the gate
    weaker_side: str          # 'left' or 'right' — the arm that curled less (coaching only)
    shortfall: float | None   # gate − progress when the curl is short; None at/over the gate
    # The arms actually measured this frame ('both', 'left' or 'right'); a missing arm's ratio
    # above is the other arm's.
    arms_seen: str = "both"


class CurlRomRule:
    """Stateless-per-frame curl ROM rule. Construction fixes the person's resting reference (from
    the persisted baseline) and the gate; `read()` turns a live frame into a `CurlRomReading`; and
    `is_full_rom()` is the gate the rep machine applies to a rep's peak `progress` to decide full
    vs shallow.

    Args:
        baseline:          persisted per-set baseline keypoints (arms hanging extended).
        target_offset:     normalized wrist offset mapping to progress 1.0, in upper-arm lengths
                           below the shoulder (0.0 ⇒ wrist level with the shoulder).
        full_rom_gate:     the sole full-rep credit point on `progress` (e.g. 0.75).
        min_upper_arm_px:  reject a baseline or live frame whose shoulder→elbow span is below this.

    Raises ValueError on an unreadable baseline, an implausibly small baseline upper arm, a resting
    hang that does not sit below the target, or a non-positive gate — the wiring catches it and
    simply runs no ROM analysis rather than emitting nonsense.
    """

    def __init__(
        self,
        baseline: dict,
        target_offset: float,
        full_rom_gate: float,
        *,
        min_upper_arm_px: float,
    ) -> None:
        if not full_rom_gate > 0.0:
            raise ValueError(f"full ROM gate must be positive, got {full_rom_gate}")
        points = reference_xy(baseline, BASELINE_KEYPOINTS)
        if points is None:
            raise ValueError(
                "curl baseline requires finite shoulder, elbow and wrist coordinates"
            )

        self._target_offset = float(target_offset)
        self._min_upper_arm_px = float(min_upper_arm_px)
        self._full_rom_gate = float(full_rom_gate)

        self._rest: dict[str, float] = {}
        self._span: dict[str, float] = {}
        self._upper_arm: dict[str, float] = {}
        for side in _SIDES:
            upper_arm = hypot(
                points[f"{side}_shoulder"][0] - points[f"{side}_elbow"][0],
                points[f"{side}_shoulder"][1] - points[f"{side}_elbow"][1],
            )
            if upper_arm < self._min_upper_arm_px:
                raise ValueError(
                    f"baseline {side} upper arm ({upper_arm:.1f}px) is below the minimum plausible "
                    f"{min_upper_arm_px}px; recapture the baseline with both arms in view."
                )
            rest = (points[f"{side}_wrist"][1] - points[f"{side}_shoulder"][1]) / upper_arm
            span = rest - self._target_offset
            if not span > _MIN_REST_SPAN:
                raise ValueError(
                    f"baseline {side} resting wrist offset ({rest:.3f}) must sit below the curl "
                    f"target ({self._target_offset}); recapture with the arms hanging extended."
                )
            self._rest[side] = rest
            self._span[side] = span
            self._upper_arm[side] = upper_arm

    # ------------------------------------------------------------------
    def read(self, keypoints: dict) -> CurlRomReading | None:
        """Compute this frame's curl progress from live shoulder, elbow and wrist landmarks.

        An arm is measured when its elbow and wrist are usable and its upper arm reads plausibly
        long; an arm that is not stands in as the other arm's reading. Returns None when a shoulder
        is missing or below CONFIDENCE_MIN, or when neither arm can be measured — the caller
        must treat this frame as "no reading" (never advance a rep or score on partial data)."""
        pts = usable_xy(keypoints, REQUIRED_KEYPOINTS)
        if pts is None:
            return None

        ratios: dict[str, float] = {}
        offsets: dict[str, float] = {}
        for side in _SIDES:
            arm = usable_xy(keypoints, tuple(f"{side}_{joint}" for joint in _ARM_JOINTS))
            if arm is None:
                continue
            shoulder = pts[f"{side}_shoulder"]
            elbow = arm[f"{side}_elbow"]
            wrist = arm[f"{side}_wrist"]
            upper_arm = hypot(shoulder[0] - elbow[0], shoulder[1] - elbow[1])
            if not upper_arm >= self._min_upper_arm_px:
                continue
            offset = (wrist[1] - shoulder[1]) / upper_arm
            ratio = (self._rest[side] - offset) / self._span[side]
            if not (isfinite(offset) and isfinite(ratio)):
                continue
            offsets[side] = offset
            ratios[side] = ratio
        if not ratios:
            return None
        arms_seen = "both" if len(ratios) == 2 else next(iter(ratios))
        for side, other in (("left", "right"), ("right", "left")):
            if side not in ratios:
                ratios[side], offsets[side] = ratios[other], offsets[other]

        progress = max(ratios["left"], ratios["right"])
        leading = progress
        # Ties resolve to the left arm; coaching only.
        weaker_side = "left" if ratios["left"] <= ratios["right"] else "right"

        return CurlRomReading(
            progress=progress,
            leading_ratio=leading,
            left_ratio=ratios["left"],
            right_ratio=ratios["right"],
            left_offset=round(offsets["left"], 4),
            right_offset=round(offsets["right"], 4),
            full_rom_gate=self._full_rom_gate,
            full_rom=self.is_full_rom(progress),
            left_full=self.is_full_rom(ratios["left"]),
            right_full=self.is_full_rom(ratios["right"]),
            weaker_side=weaker_side,
            shortfall=(
                round(self._full_rom_gate - progress, 3)
                if progress < self._full_rom_gate
                else None
            ),
            arms_seen=arms_seen,
        )

    def is_full_rom(self, progress: float) -> bool:
        """The gate: True once `progress` reaches the configured full-ROM boundary. Applied to a
        rep's PEAK `progress` (the leading arm), peak < gate ⇒ the rep is SHALLOW. The single
        definition of a full curl, so the per-frame `full_rom` and the per-rep shallow verdict can
        never disagree (both go through here)."""
        return progress >= self._full_rom_gate

    # ------------------------------------------------------------------
    @property
    def full_rom_gate(self) -> float:
        """The sole full-rep credit point."""
        return self._full_rom_gate

    def rest_offset(self, side: str) -> float:
        """This person's resting wrist offset for one arm — the signal's zero point.

        Exposed for offline analysis: when a capture's numbers look wrong, the baseline reference is
        the first thing to inspect."""
        return self._rest[_side(side)]

    def baseline_upper_arm_px(self, side: str) -> float:
        """The baseline shoulder→elbow span for one arm, in pixels — the signal's scale."""
        return self._upper_arm[_side(side)]
