/**
 * src/geometry/projection.ts
 *
 * Creates an Azimuthal Equidistant (AEQD) projection centred on the centroid
 * of the supplied input points.
 *
 * AEQD preserves distances and angles from the centre point, making it suitable
 * for metric computations (area, distance, simplification) over small local areas
 * such as running routes.
 *
 * EPSG:3857 (Web Mercator) is FORBIDDEN — it inflates area by sec²(lat), which
 * at 55 °N is a factor of ~3.  Never import or reference Web Mercator here.
 *
 * NOTE — Antimeridian: if the centroid longitude wraps across the antimeridian
 * (+/-180°), the arithmetic mean of longitudes will be incorrect.  This
 * implementation does NOT handle antimeridian-spanning polygons.
 * TODO: add antimeridian detection and throw a typed error if the longitude
 * spread of the input exceeds ~180° (RM-future).
 */

import proj4 from "proj4";
import type { LatLng, PlanarXY, Projection } from "./types.js";

// ── Error ────────────────────────────────────────────────────────────────────

export class EmptyProjectionInputError extends Error {
  constructor() {
    super("createLocalProjection requires at least one point");
    this.name = "EmptyProjectionInputError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeCentroid(points: readonly LatLng[]): LatLng {
  // Simple arithmetic mean — valid when all points are far from the antimeridian.
  let sumLat = 0;
  let sumLng = 0;
  for (const p of points) {
    sumLat += p.lat;
    sumLng += p.lng;
  }
  return {
    lat: sumLat / points.length,
    lng: sumLng / points.length,
  };
}

function aeqdDefinition(lat0: number, lon0: number): string {
  return (
    `+proj=aeqd +lat_0=${lat0} +lon_0=${lon0}` +
    ` +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`
  );
}

// WGS84 geographic CRS definition (source for all projections)
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a local Azimuthal Equidistant projection centred on the centroid of
 * the supplied points.
 *
 * @param points - At least one WGS84 coordinate. Throws EmptyProjectionInputError
 *                 if the array is empty.
 * @returns A Projection that maps WGS84 ↔ local planar metres.
 */
export function createLocalProjection(points: readonly LatLng[]): Projection {
  if (points.length === 0) {
    throw new EmptyProjectionInputError();
  }

  const centre = computeCentroid(points);
  const aeqdDef = aeqdDefinition(centre.lat, centre.lng);

  // proj4 forward:  WGS84  → AEQD  ([lng, lat] → [x, y])
  // proj4 inverse:  AEQD   → WGS84 ([x, y] → [lng, lat])
  const forward = proj4(WGS84, aeqdDef);
  const inverse = proj4(aeqdDef, WGS84);

  return {
    toPlanar(p: LatLng): PlanarXY {
      const result: number[] = forward.forward([p.lng, p.lat]);
      return { x: result[0] ?? 0, y: result[1] ?? 0 };
    },

    toLatLng(p: PlanarXY): LatLng {
      const result: number[] = inverse.forward([p.x, p.y]);
      return { lat: result[1] ?? 0, lng: result[0] ?? 0 };
    },
  };
}

/**
 * Expose the AEQD proj4 definition string for a given centre point.
 * Useful in tests and diagnostics — not required by production callers.
 */
export function aeqdDefinitionFor(centre: LatLng): string {
  return aeqdDefinition(centre.lat, centre.lng);
}
