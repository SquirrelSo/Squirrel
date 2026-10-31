"""Pure proximity scoring: RSSI → approximate distance band, repeated sightings → confirmation.

RSSI is a rough signal: walls, bodies, phone orientation and cases easily move it by 10 dB, so
bands are deliberately coarse and a single packet never confirms anything. Confirmation needs
several spaced sightings over a minimum dwell time with a strong median signal — someone walking
past does not qualify.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from typing import Iterable, Literal

Proximity = Literal["very_close", "nearby", "far"]

# Approximate bands (typical phones, line of sight): ≥ -60 dBm ≈ 0–2 m, ≥ -75 dBm ≈ 2–5 m.
VERY_CLOSE_RSSI = -60
NEARBY_RSSI     = -75

EVIDENCE_WINDOW_SECONDS  = 5 * 60    # only sightings this recent (relative to the newest) count
MIN_DETECTIONS           = 3
MIN_DWELL_SECONDS        = 60        # first → last sighting span needed to confirm
MIN_SAMPLE_SPACING_SEC   = 5         # sightings closer than this from one observer are duplicates
MAX_SAMPLES_PER_PAIR     = 64
RELATIONSHIP_TTL_SECONDS = 15 * 60   # no qualifying sighting for this long → relationship expires

# Linear signal score between these RSSI values (0 at the floor, 1 at the ceiling).
_SIGNAL_FLOOR, _SIGNAL_CEIL = -90, -55


@dataclass(frozen=True)
class Sample:
    at: float        # epoch seconds (observer clock, clamped to server now)
    rssi: int
    observer: str    # user id of the phone that saw the other


@dataclass(frozen=True)
class Assessment:
    confirmed: bool
    proximity: Proximity
    confidence: float
    mutual: bool
    median_rssi: float
    count: int
    first_at: float
    last_at: float


def classify_rssi(rssi: float) -> Proximity:
    if rssi >= VERY_CLOSE_RSSI:
        return "very_close"
    if rssi >= NEARBY_RSSI:
        return "nearby"
    return "far"


def window(samples: Iterable[Sample]) -> list[Sample]:
    """Samples within EVIDENCE_WINDOW_SECONDS of the newest one, oldest first."""
    ordered = sorted(samples, key=lambda s: s.at)
    if not ordered:
        return []
    cutoff = ordered[-1].at - EVIDENCE_WINDOW_SECONDS
    return [s for s in ordered if s.at >= cutoff]


def assess(samples: Iterable[Sample]) -> Assessment | None:
    recent = window(samples)
    if not recent:
        return None
    median = statistics.median(s.rssi for s in recent)
    proximity = classify_rssi(median)
    span = recent[-1].at - recent[0].at
    mutual = len({s.observer for s in recent}) >= 2

    signal = min(1.0, max(0.0, (median - _SIGNAL_FLOOR) / (_SIGNAL_CEIL - _SIGNAL_FLOOR)))
    confidence = round(
        0.4 * signal
        + 0.2 * min(1.0, len(recent) / 8)
        + 0.2 * min(1.0, span / 180)
        + 0.2 * (1.0 if mutual else 0.0),
        2,
    )
    confirmed = proximity != "far" and len(recent) >= MIN_DETECTIONS and span >= MIN_DWELL_SECONDS
    return Assessment(
        confirmed=confirmed,
        proximity=proximity,
        confidence=confidence,
        mutual=mutual,
        median_rssi=float(median),
        count=len(recent),
        first_at=recent[0].at,
        last_at=recent[-1].at,
    )
