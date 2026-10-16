"""Push-up-local geometry shared by its rule kernels. Not an engine primitive.

Everything here exists because a push-up is coached from the SIDE, which makes two problems common
to all of its rules:

    1. ONE SIDE OF THE BODY IS OCCLUDED. In profile the far arm and leg sit behind the near ones, so
       a rule cannot simply require both. ``analysis_side`` picks the side the camera can actually
       see, and each rule reads that chain.
    2. THE BODY AXIS IS HORIZONTAL. Squat and curl can treat "up" as the torso direction of a
       standing person; a push-up cannot, so the body line is measured as a signed offset from the
       shoulder-to-ankle line rather than as a lean from vertical.

Frames arrive in PIXEL coordinates (the browser sends landmark x/y in image pixels, see
backend/core/frame.py), with y growing downward. That is a simplification over the standalone
pose service this rule set was ported from, which worked in MediaPipe's normalized space and had to
correct for frame aspect ratio before every angle; here there is nothing to correct.
"""

from __future__ import annotations

from math import acos, atan2, degrees, hypot
from numbers import Real

from backend.config import CONFIDENCE_MIN

Point = tuple[float, float]

#: The two body sides, in the order ties are broken (left wins an exact tie, deterministically).
SIDES = ("left", "right")


def side_names(side: str, joints: tuple[str, ...]) -> tuple[str, ...]:
    """Landmark names for one side's joint chain, e.g. ``("left_shoulder", "left_elbow")``."""
    return tuple(f"{side}_{joint}" for joint in joints)


def analysis_side(keypoints: dict, joints: tuple[str, ...]) -> str:
    """Which side of the body to measure: the one this frame tracks more confidently.

    In a correct side-on view the camera-facing chain is reported with clearly higher visibility than
    the occluded far chain, so this resolves to the near side. It is deliberately a per-frame
    decision rather than a side fixed at setup: the persisted baseline stores geometry without
    visibility (see core.keypoints.reference_xy), so setup cannot tell the sides apart — and it does
    not need to, because in profile both chains project to nearly the same place, which is exactly
    why swapping between them changes the measured angles very little.

    Ties break to ``left`` so the choice is reproducible frame to frame.
    """
    scores = {side: _mean_visibility(keypoints, side_names(side, joints)) for side in SIDES}
    return "left" if scores["left"] >= scores["right"] else "right"


def _mean_visibility(keypoints: dict, names: tuple[str, ...]) -> float:
    total = 0.0
    for name in names:
        landmark = keypoints.get(name)
        visibility = landmark.get("v") if isinstance(landmark, dict) else None
        if isinstance(visibility, Real) and not isinstance(visibility, bool):
            total += float(visibility)
    return total / len(names) if names else 0.0


def usable_side(
    keypoints: dict,
    joints: tuple[str, ...],
    reader,
    allowed: tuple[str, ...] | None = None,
) -> tuple[str, dict[str, Point]] | None:
    """Read the better-tracked side's chain, falling back to the other side.

    ``reader`` is ``core.keypoints.usable_xy`` for live frames or ``reference_xy`` for a persisted
    baseline, so the same side-selection logic serves both without loosening the live confidence
    floor (``CONFIDENCE_MIN``) that ``usable_xy`` enforces.

    ``allowed`` restricts the choice to sides the caller can actually use — a rule whose baseline
    only resolved for one side must not analyse the other, however well tracked it is.

    Returns ``(side, {joint: (x, y)})`` with the joint keys stripped of their side prefix, or None
    when neither side is fully readable — the caller then treats the frame as "no reading" rather
    than measuring half a body.
    """
    preferred = analysis_side(keypoints, joints)
    for side in (preferred, _other(preferred)):
        if allowed is not None and side not in allowed:
            continue
        points = reader(keypoints, side_names(side, joints))
        if points is not None:
            return side, {joint: points[f"{side}_{joint}"] for joint in joints}
    return None


def _other(side: str) -> str:
    return "right" if side == "left" else "left"


def joint_angle(first: Point, vertex: Point, last: Point) -> float | None:
    """Interior angle at ``vertex``, in degrees [0, 180]; None if either limb is degenerate.

    ``joint_angle(shoulder, elbow, wrist)`` is the elbow bend: 180 is a locked-out arm, smaller is
    a deeper bend.
    """
    first_vector = (first[0] - vertex[0], first[1] - vertex[1])
    last_vector = (last[0] - vertex[0], last[1] - vertex[1])
    first_length = hypot(*first_vector)
    last_length = hypot(*last_vector)
    if first_length == 0.0 or last_length == 0.0:
        return None
    cosine = _dot(first_vector, last_vector) / (first_length * last_length)
    return degrees(acos(max(-1.0, min(1.0, cosine))))


def degrees_from_horizontal(start: Point, end: Point) -> float | None:
    """Angle of a segment against the image horizontal, in [0, 90]; None if degenerate.

    0 is a perfectly horizontal segment (the torso of someone in a plank), 90 a vertical one (the
    torso of someone standing). Direction-agnostic on purpose: it must not matter whether the user
    faces camera-left or camera-right, nor which end is passed first.
    """
    run = abs(end[0] - start[0])
    rise = abs(end[1] - start[1])
    if run == 0.0 and rise == 0.0:
        return None
    return degrees(atan2(rise, run))


def line_offset(start: Point, end: Point, point: Point) -> float | None:
    """Signed distance of ``point`` from the ``start``-``end`` line, normalized by its length.

    POSITIVE means ``point`` lies on the downward side of the line in image coordinates. For a
    push-up measured shoulder-to-ankle that is the floor side, so positive is a SAGGING hip and
    negative a piked one — the sign carries the coaching direction, not just its magnitude.

    Normalizing by the span makes the reading independent of body size and camera distance, and
    returns None for a degenerate (zero-length) span.
    """
    axis = (end[0] - start[0], end[1] - start[1])
    span = hypot(*axis)
    if span == 0.0:
        return None
    # Normal to the body axis, chosen to point down the image (+y) so the sign is anatomical.
    normal = (-axis[1] / span, axis[0] / span)
    if normal[1] < 0.0:
        normal = (-normal[0], -normal[1])
    offset = (point[0] - start[0], point[1] - start[1])
    return _dot(offset, normal) / span


def midpoint(first: Point, second: Point) -> Point:
    return ((first[0] + second[0]) / 2.0, (first[1] + second[1]) / 2.0)


def distance(first: Point, second: Point) -> float:
    return hypot(second[0] - first[0], second[1] - first[1])


def _dot(first: Point, second: Point) -> float:
    return first[0] * second[0] + first[1] * second[1]


__all__ = [
    "CONFIDENCE_MIN",
    "Point",
    "SIDES",
    "analysis_side",
    "degrees_from_horizontal",
    "distance",
    "joint_angle",
    "line_offset",
    "midpoint",
    "side_names",
    "usable_side",
]
