"""Named campus zones (Library, Sports Ground Loop…), for Squirrel Dates.

Zones are configuration, not user data: SOCIAL_ZONES_FILE (a JSON file) or SOCIAL_ZONES (the same
JSON inline). Empty means Squirrel Dates reports "campus zones aren't set up yet". The format:

    [{"id": "library", "name": "Library", "polygon": [[22.9639, 88.5268], [22.9641, 88.5278], ...]},
     {"id": "sports", "name": "Sports Ground Loop", "center": [22.9643, 88.5206], "radius_m": 120}]

`polygon` is [lat, lng] pairs (closed implicitly); `center` + `radius_m` is a circle. Pure: no I/O
beyond reading the file, no clock.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

ZONE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
# A run "visits" a zone only when at least this many of its points fall inside: one stray GPS fix
# at the edge of a zone is not a visit.
MIN_POINTS_IN_ZONE = 2


@dataclass(frozen=True)
class Zone:
    id: str
    name: str
    polygon: tuple[tuple[float, float], ...] = ()
    center: tuple[float, float] | None = None
    radius_m: float | None = None

    def contains(self, lat: float, lng: float) -> bool:
        if self.center is not None and self.radius_m is not None:
            return _distance_m(lat, lng, *self.center) <= self.radius_m
        return _in_polygon(lat, lng, self.polygon)


def parse_zones(raw: str | None) -> tuple[Zone, ...]:
    """Zones from the JSON text; raises ValueError naming the first bad entry (fail at start-up)."""
    if not raw or not raw.strip():
        return ()
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("campus zones must be a JSON list")
    zones: list[Zone] = []
    seen: set[str] = set()
    for i, z in enumerate(data):
        where = f"campus zone #{i + 1}"
        if not isinstance(z, dict):
            raise ValueError(f"{where} must be an object")
        zid, name = z.get("id"), z.get("name")
        if not isinstance(zid, str) or not ZONE_ID_RE.fullmatch(zid):
            raise ValueError(f"{where}: id must be 1–40 of a-z, 0-9, '_' or '-'")
        if zid in seen:
            raise ValueError(f"{where}: duplicate id {zid!r}")
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ValueError(f"{where} ({zid}): name must be 1–80 characters")
        seen.add(zid)
        if "polygon" in z:
            pts = z["polygon"]
            if not isinstance(pts, list) or len(pts) < 3 or not all(_is_latlng(p) for p in pts):
                raise ValueError(f"{where} ({zid}): polygon must be at least 3 [lat, lng] pairs")
            zones.append(Zone(zid, name.strip(), polygon=tuple((float(p[0]), float(p[1])) for p in pts)))
        elif "center" in z:
            radius = z.get("radius_m")
            if not _is_latlng(z["center"]) or not isinstance(radius, (int, float)) or not 10 <= radius <= 2000:
                raise ValueError(f"{where} ({zid}): center must be [lat, lng] and radius_m 10–2000")
            zones.append(Zone(zid, name.strip(), center=(float(z["center"][0]), float(z["center"][1])), radius_m=float(radius)))
        else:
            raise ValueError(f"{where} ({zid}): give a polygon, or a center and radius_m")
    return tuple(zones)


def load_zones(inline: str | None, path: str | None) -> tuple[Zone, ...]:
    if inline and inline.strip():
        return parse_zones(inline)
    if path:
        with open(path, encoding="utf-8") as f:
            return parse_zones(f.read())
    return ()


def zones_visited(points: Iterable[tuple[float, float, datetime]], zones: Iterable[Zone]) -> dict[str, datetime]:
    """zone id → the time of the run's first point inside it, for each zone the run visited."""
    zones = list(zones)
    first: dict[str, datetime] = {}
    counts: dict[str, int] = {}
    for lat, lng, at in points:
        for z in zones:
            if z.contains(lat, lng):
                counts[z.id] = counts.get(z.id, 0) + 1
                if z.id not in first or at < first[z.id]:
                    first[z.id] = at
    return {zid: at for zid, at in first.items() if counts[zid] >= MIN_POINTS_IN_ZONE}


def _is_latlng(p) -> bool:
    return (isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(v, (int, float)) for v in p)
            and -90 <= p[0] <= 90 and -180 <= p[1] <= 180)


def _in_polygon(lat: float, lng: float, poly: tuple[tuple[float, float], ...]) -> bool:
    """Ray casting on [lat, lng]; fine at campus scale (no pole or antimeridian)."""
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        yi, xi = poly[i]
        yj, xj = poly[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))
