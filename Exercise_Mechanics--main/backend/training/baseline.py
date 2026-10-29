"""Quality-aware baseline collection and atomic persistence."""

from __future__ import annotations

import json
import os
import statistics
import tempfile
from dataclasses import asdict, dataclass
from math import isfinite
from numbers import Real
from pathlib import Path

from backend.config import CONFIDENCE_MIN

_BASELINE_DIRNAME = "baseline_kp_data"
_QUALITY_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class BaselineQuality:
    """How steady the captured reference was.

    `max_joint_stddev_px` is the worst joint's standard deviation in camera pixels (reported for
    diagnostics). Pixels depend on how big the person is in the picture, so the stillness decision
    uses `max_joint_stddev_rel`: the same figure divided by the person's own torso length
    (`body_scale_px`). Measured on real footage, a person holding still sways ~0.07 of a torso
    length at every distance from far (15 % of the frame) to close (55 %), while a fixed 8 px limit
    passed only at 15 % and never from 40 % — which forced people to stand far away.
    """

    valid_samples: int
    observed_frames: int
    valid_coverage: float
    valid_duration_ms: float
    max_joint_stddev_px: float
    joint_stddev_px: dict[str, dict[str, float]]
    body_scale_px: float | None = None
    max_joint_stddev_rel: float | None = None

    def as_dict(self) -> dict:
        return asdict(self)


class BaselineCollector:
    """Collect only complete visible references; no required landmark can fall back to zero.

    ``either_side`` names joints needed on ONE side only (a side-on exercise: the far side is hidden
    behind the near one). A frame counts when either side's whole chain is visible; both sides'
    positions are kept (the hidden ones as the pose model predicts them) so the reference has every
    joint, but stillness and body size are measured on the side that was in view."""

    def __init__(
        self,
        required_keypoints: tuple[str, ...],
        *,
        min_visibility: float = CONFIDENCE_MIN,
        either_side: tuple[str, ...] = (),
    ) -> None:
        if (not required_keypoints and not either_side) or len(set(required_keypoints)) != len(required_keypoints):
            raise ValueError("baseline required_keypoints must be unique and non-empty")
        self._required = required_keypoints
        self._sides = {
            side: tuple(f"{side}_{base}" for base in either_side) for side in ("left", "right")
        } if either_side else {}
        self._stored = (*required_keypoints, *self._sides.get("left", ()), *self._sides.get("right", ()))
        self._min_visibility = float(min_visibility)
        self._frames: list[dict[str, dict[str, float]]] = []

    @property
    def frame_count(self) -> int:
        return len(self._frames)

    @property
    def frames(self) -> tuple[dict[str, dict[str, float]], ...]:
        return tuple(self._frames)

    def add(self, keypoints: dict) -> None:
        frame: dict[str, dict[str, float]] = {}
        if self._sides and not any(
            all(
                isinstance(keypoints.get(name), dict)
                and isinstance(keypoints[name].get("v"), (int, float))
                and keypoints[name]["v"] >= self._min_visibility
                for name in names
            )
            for names in self._sides.values()
        ):
            raise ValueError("baseline frame has no side fully visible")
        for name in self._stored:
            side_joint = name not in self._required
            landmark = keypoints.get(name)
            if not isinstance(landmark, dict):
                raise ValueError(f"baseline frame is missing '{name}'")
            x = _finite(landmark.get("x"), f"baseline.{name}.x")
            y = _finite(landmark.get("y"), f"baseline.{name}.y")
            visibility = _finite(landmark.get("v"), f"baseline.{name}.v")
            if visibility < self._min_visibility and not side_joint:
                raise ValueError(f"baseline landmark '{name}' is below the confidence floor")
            point = {"x": x, "y": y, "v": visibility}
            if "z" in landmark:
                point["z"] = _finite(landmark.get("z"), f"baseline.{name}.z")
            frame[name] = point
        self._frames.append(frame)

    def median(self) -> dict | None:
        if not self._frames:
            return None
        median = statistics.median
        result: dict[str, dict[str, float]] = {}
        for name in self._stored:
            points = [frame[name] for frame in self._frames]
            axes = {"x", "y"}
            if all("z" in point for point in points):
                axes.add("z")
            result[name] = {
                axis: round(float(median([point[axis] for point in points])), 3)
                for axis in sorted(axes)
            }
        return result

    def quality(
        self,
        *,
        observed_frames: int,
        valid_duration_ms: float,
    ) -> BaselineQuality:
        if observed_frames < self.frame_count:
            raise ValueError("observed_frames cannot be below valid sample count")
        deviations: dict[str, dict[str, float]] = {}
        maxima: list[float] = []
        for name in self._measured():
            points = [frame[name] for frame in self._frames]
            axes = {
                axis: round(float(statistics.pstdev(point[axis] for point in points)), 6)
                for axis in ("x", "y")
            }
            deviations[name] = axes
            maxima.extend(axes.values())
        coverage = self.frame_count / observed_frames if observed_frames else 0.0
        worst = max(maxima, default=0.0)
        scale = self._body_scale_px()
        return BaselineQuality(
            valid_samples=self.frame_count,
            observed_frames=observed_frames,
            valid_coverage=round(coverage, 6),
            valid_duration_ms=round(float(valid_duration_ms), 6),
            max_joint_stddev_px=worst,
            joint_stddev_px=deviations,
            body_scale_px=None if scale is None else round(scale, 3),
            max_joint_stddev_rel=None if scale is None else round(worst / scale, 6),
        )

    def _body_scale_px(self) -> float | None:
        """The person's size in the picture: the median torso length (shoulder midpoint to hip
        midpoint) when both shoulders and hips are captured; side-on (``either_side``), the near
        side's shoulder-to-hip length; else a third of the median height of the captured joints (a
        torso is about a third of the shoulder-to-ankle extent). None when nothing measurable was
        captured."""
        if not self._frames:
            return None
        measured = self._measured()
        torso = ("left_shoulder", "right_shoulder", "left_hip", "right_hip")
        near = next(
            ((f"{side}_shoulder", f"{side}_hip") for side in ("left", "right")
             if f"{side}_shoulder" in measured and f"{side}_hip" in measured),
            None,
        )
        if self._sides and near is not None:
            # Side-on: the near side's own shoulder-to-hip length.
            shoulder, hip = near
            scale = statistics.median(
                ((f[shoulder]["x"] - f[hip]["x"]) ** 2 + (f[shoulder]["y"] - f[hip]["y"]) ** 2) ** 0.5
                for f in self._frames
            )
        elif all(name in measured for name in torso):
            lengths = []
            for frame in self._frames:
                sx = (frame["left_shoulder"]["x"] + frame["right_shoulder"]["x"]) / 2
                sy = (frame["left_shoulder"]["y"] + frame["right_shoulder"]["y"]) / 2
                hx = (frame["left_hip"]["x"] + frame["right_hip"]["x"]) / 2
                hy = (frame["left_hip"]["y"] + frame["right_hip"]["y"]) / 2
                lengths.append(((sx - hx) ** 2 + (sy - hy) ** 2) ** 0.5)
            scale = statistics.median(lengths)
        else:
            heights = [
                max(frame[n]["y"] for n in measured) - min(frame[n]["y"] for n in measured)
                for frame in self._frames
            ]
            scale = statistics.median(heights) / 3.0
        return scale if isfinite(scale) and scale > 0 else None

    def _measured(self) -> tuple[str, ...]:
        """The joints stillness and size are measured on: the required ones, plus the side that was
        in view (the higher mean visibility over the capture)."""
        if not self._sides:
            return self._required
        if not self._frames:
            return (*self._required, *self._sides["left"])
        seen = {
            side: statistics.fmean(frame[name]["v"] for frame in self._frames for name in names)
            for side, names in self._sides.items()
        }
        return (*self._required, *self._sides[max(seen, key=lambda side: (seen[side], side == "left"))])

    def reset(self) -> None:
        self._frames.clear()


def save_baseline(
    set_dir: Path,
    baseline: dict,
    quality: BaselineQuality,
    filename: str,
) -> Path:
    """Atomically publish one baseline document containing geometry and capture quality."""
    if Path(filename).name != filename or not filename.endswith(".json"):
        raise ValueError("baseline filename must be a safe JSON filename")
    output_dir = Path(set_dir) / _BASELINE_DIRNAME
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / filename
    payload = {
        "schema_version": _QUALITY_SCHEMA_VERSION,
        "keypoints": baseline,
        "quality": quality.as_dict(),
    }
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{filename}.",
        suffix=".tmp",
        dir=output_dir,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def load_baseline_document(path: Path) -> tuple[dict, dict | None] | None:
    """Read a versioned quality document while accepting legacy geometry-only baselines."""
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    if value.get("schema_version") == _QUALITY_SCHEMA_VERSION:
        keypoints = value.get("keypoints")
        quality = value.get("quality")
        if not isinstance(keypoints, dict) or not isinstance(quality, dict):
            return None
        return keypoints, quality
    return value, None


def _finite(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise ValueError(f"{name} must be numeric")
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result
