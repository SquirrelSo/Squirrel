"""Depth rule — the squat's range-of-motion signal + full/shallow gate.

This is one biomechanical rule kernel (template id `depth`, "Short depth"), built to stand
completely on its own — no rep FSM, no phase machine, no rep counting. It answers two
questions from a single frame's hip landmarks (the live knees are optional):

    1. HOW DEEP is the squat right now?      → a normalized `depth_ratio` signal
    2. Is that deep enough for a FULL rep?    → the `is_full_depth()` gate

Division of responsibility (why this is FSM-free):
    • This rule owns WHAT "full depth" means (one gate) and how depth is measured.
    • A rep machine (built separately) owns WHEN — it tracks each rep's PEAK depth and asks
      this rule `is_full_depth(peak)`. A rep is flagged SHALLOW when that is False.
    So the shallow/partial-rep verdict is a trivial function of this rule's gate applied to a
    peak — the rule provides the brain, the FSM provides the timing. Nothing here needs to
    know about setup/descent/bottom/ascent/reset.

The measurement (the load-bearing part):

    depth_ratio = (hip_mid_y − baseline_hip_y) / (baseline_knee_y − baseline_hip_y)

        0.0  = standing (hip at its baseline height)
        1.0  = the hip has descended to the STANDING knee height (≈ parallel)
        >1.0 = deeper than parallel (hip below the standing knee line)
        <0.0 = hip rose above standing (e.g. onto toes) — kept raw, not clamped

    Image y grows downward, so a descending hip means an INCREASING hip_mid_y. Because the
    signal is a ratio of two pixel spans it is invariant to body size and camera distance.
    The denominator (standing hip→knee span) is taken from the BASELINE, not the live frame:
    the live knee drifts forward and is noisy mid-squat, so the fixed standing knee is the
    stable reference. `hip_below_knee` (hip vs LIVE knee) is a separate ATG indicator, kept
    purely informational — it drives nothing.

For squat (an FSM-1 / descend-first movement) `depth_ratio` doubles as the rep machine's
progress signal (0 at rest → grows to a peak at the bottom). A different exercise would
supply its own signal kernel; this one stays squat-specific but FSM-agnostic.

Only the hips are required live. When the camera is close, the knees sit at the bottom edge of
the image as the person squats and lose confidence; depth must not depend on them. The signal is
deliberately just the hip drop: guards built from knee or shin lengths in the image read a real
front-view squat as straight legs (the knees come toward the camera and drop in the image) and
stopped every rep from counting.

Thresholds are NOT hardcoded here. ``full_rom_gate`` is passed verbatim from the squat template
and is the sole credit boundary; depth deliberately has no hysteresis.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.core.keypoints import usable_xy

RULE_ID = "depth"
# Anatomical inputs are stable kernel metadata; thresholds remain in configuration.
REQUIRED_KEYPOINTS = ("left_hip", "right_hip")
KNEE_KEYPOINTS = ("left_knee", "right_knee")   # optional: only for hip_below_knee


@dataclass(frozen=True)
class DepthReading:
    """One frame's depth read. `depth_ratio` is the raw signal (unrounded — the rep machine
    compares peaks against the gate, so precision matters); presentation rounding is a caller
    concern."""
    depth_ratio:    float          # 0.0 standing → 1.0 hip at standing-knee height (>1 deeper)
    hip_below_knee: bool | None    # live ATG indicator (hip below the CURRENT knee), None without
                                   # usable knees — informational only
    full_rom_gate:  float          # the sole full-ROM boundary from exercise config
    full_depth:     bool           # did THIS frame reach the gate (depth_ratio ≥ gate)
    shortfall:      float | None   # distance below the gate; None when at/over the gate


class DepthRule:
    """Stateless-per-frame depth rule. Construction fixes the reference frame (the standing
    baseline) and the gate; `read()` turns a live frame into a `DepthReading`; `is_full_depth()`
    is the gate the rep machine applies to a rep's peak to decide full vs shallow.

    Args:
        baseline_hip_y:  standing hip-midpoint y (mean of the baseline left/right hip y).
        baseline_knee_y: standing knee-midpoint y (mean of the baseline left/right knee y).
        full_rom_gate:   the sole full-rep credit point (e.g. 0.85).
        min_baseline_span_px: reject a baseline whose hip→knee span is below this.

    Raises ValueError on an anatomically impossible baseline (knee not below hip), an
    implausibly small ROM or a non-positive gate — the wiring
    catches it and simply runs no depth analysis rather than emitting nonsense.
    """

    def __init__(
        self,
        baseline_hip_y: float,
        baseline_knee_y: float,
        full_rom_gate: float,
        *,
        min_baseline_span_px: float,
    ) -> None:
        # Image y grows downward → a standing knee sits BELOW (greater y than) the hip.
        if not baseline_knee_y > baseline_hip_y:
            raise ValueError(
                f"baseline knee y ({baseline_knee_y}) must be below hip y ({baseline_hip_y}); "
                f"image y grows downward — check the baseline."
            )
        rom = baseline_knee_y - baseline_hip_y
        if rom < min_baseline_span_px:
            raise ValueError(
                f"baseline hip→knee span ({rom:.1f}px) is below the minimum plausible "
                f"{min_baseline_span_px}px; recalibrate standing upright."
            )
        if not full_rom_gate > 0.0:
            raise ValueError(f"full ROM gate must be positive, got {full_rom_gate}")

        self._baseline_hip_y = float(baseline_hip_y)
        self._rom = float(rom)
        self._full_rom_gate = float(full_rom_gate)

    # ------------------------------------------------------------------
    def read(self, keypoints: dict) -> DepthReading | None:
        """Compute this frame's depth from the live hip landmarks.

        Returns None when either hip landmark is missing or below CONFIDENCE_MIN —
        a low-confidence joint carries ±jitter that would corrupt the signal, so the caller
        must treat this frame as "no reading" (never advance a rep or score on partial data)."""
        pts = usable_xy(keypoints, REQUIRED_KEYPOINTS)
        if pts is None:
            return None

        hip_mid_y = (pts["left_hip"][1] + pts["right_hip"][1]) / 2.0
        depth = (hip_mid_y - self._baseline_hip_y) / self._rom
        knees = usable_xy(keypoints, KNEE_KEYPOINTS)
        hip_below_knee = (
            None if knees is None
            else hip_mid_y > (knees["left_knee"][1] + knees["right_knee"][1]) / 2.0
        )

        return DepthReading(
            depth_ratio=depth,
            hip_below_knee=hip_below_knee,
            full_rom_gate=self._full_rom_gate,
            full_depth=self.is_full_depth(depth),
            shortfall=(round(self._full_rom_gate - depth, 3) if depth < self._full_rom_gate else None),
        )

    @property
    def baseline_hip_y(self) -> float:
        """The standing hip height this person's depth is measured from — the signal's zero point.

        Exposed for capture metadata: configuration alone does not determine the signal, this
        baseline-derived reference does."""
        return self._baseline_hip_y

    @property
    def baseline_rom_px(self) -> float:
        """The standing hip→knee span, in pixels — the signal's scale."""
        return self._rom

    def is_full_depth(self, depth_ratio: float) -> bool:
        """The gate: True once depth reaches the configured full-ROM boundary. Applied to a
        rep's PEAK depth — peak < gate ⇒ the rep is SHALLOW. The single definition of a full-
        depth squat, so the per-frame `full_depth` and the per-rep shallow verdict can never
        disagree (both go through here)."""
        return depth_ratio >= self._full_rom_gate

    # ------------------------------------------------------------------
    @property
    def full_rom_gate(self) -> float:
        """The sole full-rep credit point."""
        return self._full_rom_gate
