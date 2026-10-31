"""Frame-cadence-aware tracking-gap boundary shared by the rep FSM and the evidence timeline.

``scoring.max_frame_delta_ms`` separates a resumable tracking interruption from a long gap. It was
tuned on ~30 fps webcams, where 100 ms is about three frame intervals. Low-end phones deliver pose
frames far more slowly (low-light exposure, CPU/WASM inference, thermal throttling): at 10 fps the
*normal* interval between two frames is already ~100 ms, so every frame looked like a tracking gap,
every in-progress rep was discarded and no form evidence was ever credited.

The boundary is therefore expressed in frames, not only milliseconds: it is ``tolerance_frames``
times the observed median frame interval, never below the configured ``max_frame_delta_ms`` (so a
30 fps device behaves exactly as before) and never above ``max_gap_ms`` (so a genuinely long gap is
still a gap on any device). Nothing here relaxes confidence, visibility or ROM validation; it only
stops a slow camera from being mistaken for lost tracking.

The cadence is estimated from frame *arrival* timestamps (tracked or not), so a dropout does not
inflate it, and a median over a short window ignores one-off stalls. The estimate is a pure function
of the timestamps, which keeps offline replay of a capture deterministic.
"""

from __future__ import annotations

import statistics
from collections import deque
from math import isfinite
from numbers import Real
from typing import Mapping

_WINDOW = 30          # recent inter-frame intervals considered (≈1 s at 30 fps)
_MIN_SAMPLES = 5      # below this the configured fixed boundary applies unchanged


class FrameGapBoundary:
    """Resolve the current tracking-gap limit (ms) from the observed frame cadence."""

    def __init__(self, max_frame_delta_ms: float, frame_cadence: Mapping | None = None) -> None:
        self._floor = _positive(max_frame_delta_ms, "max_frame_delta_ms")
        self._tolerance_frames: float | None = None
        self._ceiling = self._floor
        if frame_cadence is not None:
            if not isinstance(frame_cadence, Mapping):
                raise ValueError("frame_cadence must be a mapping")
            self._tolerance_frames = _positive(
                frame_cadence.get("tolerance_frames"), "frame_cadence.tolerance_frames"
            )
            self._ceiling = _positive(frame_cadence.get("max_gap_ms"), "frame_cadence.max_gap_ms")
            if self._ceiling < self._floor:
                raise ValueError("frame_cadence.max_gap_ms must be >= max_frame_delta_ms")
        self._intervals: deque[float] = deque(maxlen=_WINDOW)
        self._last_arrival_ms: float | None = None
        self._limit = self._floor

    @property
    def limit_ms(self) -> float:
        return self._limit

    @property
    def adaptive(self) -> bool:
        return self._tolerance_frames is not None

    def observe(self, t_ms: float) -> float:
        """Record one frame arrival and return the boundary that applies to it.

        The interval ending at this frame is judged against the cadence seen *before* it, so a
        single long stall cannot widen its own boundary."""
        limit = self._limit
        if self._last_arrival_ms is not None:
            delta = t_ms - self._last_arrival_ms
            if delta > 0:
                self._intervals.append(delta)
                self._limit = self._resolve()
        self._last_arrival_ms = t_ms
        return limit

    def _resolve(self) -> float:
        if self._tolerance_frames is None or len(self._intervals) < _MIN_SAMPLES:
            return self._floor
        cadence = statistics.median(self._intervals)
        return min(self._ceiling, max(self._floor, self._tolerance_frames * cadence))


def _positive(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise ValueError(f"{name} must be numeric")
    result = float(value)
    if not isfinite(result) or result <= 0:
        raise ValueError(f"{name} must be finite and positive")
    return result
