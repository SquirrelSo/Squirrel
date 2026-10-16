"""Keypoint-frame helpers shared across rule kernels (a generic primitive, not a rule)."""

from __future__ import annotations

from math import isfinite
from numbers import Real

from backend.config import CONFIDENCE_MIN


def usable_xy(
    keypoints: dict,
    names: tuple[str, ...],
    min_v: float = CONFIDENCE_MIN,
) -> dict[str, tuple[float, float]] | None:
    """Return {name: (x, y)} when EVERY landmark is present, numeric, and visible
    (v ≥ min_v); else None.

    A single missing / low-confidence joint fails the WHOLE read: a rule must never
    compute on partial data — a landmark below the confidence floor carries jitter that
    would corrupt the signal, so the caller treats this frame as "no reading" rather than
    emitting garbage. The floor defaults to CONFIDENCE_MIN (the rule-critical tier)."""
    out: dict[str, tuple[float, float]] = {}
    for name in names:
        lm = keypoints.get(name)
        if not isinstance(lm, dict):
            return None
        x, y, v = lm.get("x"), lm.get("y"), lm.get("v")
        if not (isinstance(x, Real) and isinstance(y, Real) and isinstance(v, Real)):
            return None
        if v < min_v:
            return None
        out[name] = (float(x), float(y))
    return out


def reference_xy(
    keypoints: dict,
    names: tuple[str, ...],
) -> dict[str, tuple[float, float]] | None:
    """Read finite x/y geometry from an already validated persisted reference.

    Baseline medians intentionally store geometry rather than live-frame visibility. Rule
    constructors therefore validate the required reference coordinates without inventing a
    confidence value; live reads continue to use ``usable_xy`` and its confidence floor.
    """
    out: dict[str, tuple[float, float]] = {}
    for name in names:
        landmark = keypoints.get(name)
        if not isinstance(landmark, dict):
            return None
        x, y = landmark.get("x"), landmark.get("y")
        if (
            not isinstance(x, Real)
            or isinstance(x, bool)
            or not isinstance(y, Real)
            or isinstance(y, bool)
            or not isfinite(float(x))
            or not isfinite(float(y))
        ):
            return None
        out[name] = (float(x), float(y))
    return out


def missing_keypoints(
    keypoints: dict,
    names: tuple[str, ...],
    min_v: float = CONFIDENCE_MIN,
) -> list[str]:
    """Names NOT clearly visible (present with v ≥ min_v), in the given order; empty ⇒ all
    visible. This is the setup flow's FIRST gate — every listed joint must clear the confidence
    floor before setup validation can begin. The missing list feeds live "show me your …" UI."""
    out: list[str] = []
    for name in names:
        lm = keypoints.get(name)
        v = lm.get("v") if isinstance(lm, dict) else None
        if not (isinstance(v, Real) and v >= min_v):
            out.append(name)
    return out


def missing_either_side(
    keypoints: dict,
    bases: tuple[str, ...],
    min_v: float = CONFIDENCE_MIN,
) -> list[str]:
    """For joints needed on ONE side only (a side-on exercise, where the far side is hidden behind
    the near one): empty when either side's whole chain (``left_<base>`` / ``right_<base>`` for every
    base) is visible, else the missing joints of the side closer to complete (left on a tie)."""
    if not bases:
        return []
    missing = [
        missing_keypoints(keypoints, tuple(f"{side}_{base}" for base in bases), min_v)
        for side in ("left", "right")
    ]
    return min(missing, key=len)
