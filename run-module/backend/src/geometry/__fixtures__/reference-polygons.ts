/**
 * src/geometry/__fixtures__/reference-polygons.ts
 *
 * Synthetic reference polygons for geometry unit tests.
 *
 * ALL COORDINATES ARE SYNTHETIC — no real user GPS data.
 *
 * Each fixture is a simple rectangular loop at a different latitude, sized to
 * resemble a realistic running territory (200–800 m across, 40,000–500,000 m²).
 *
 * Geodesic ground-truth areas were computed using geographiclib-geodesic
 * (PolygonArea.Compute) at the time these fixtures were created.  They are the
 * oracle against which planarAreaM2 is measured in tests.
 *
 * Geodesic area computation (oracle — test-only, never imported in production):
 *   import geoLib from "geographiclib-geodesic";
 *   const geod = geoLib.Geodesic.WGS84;
 *   const poly = geod.Polygon(false);
 *   for (const p of points) poly.AddPoint(p.lat, p.lng);
 *   const area = Math.abs(poly.Compute(false, false).area);
 */

import type { LatLng } from "../types.js";

export interface ReferencePolygon {
  /** Human-readable label for test output. */
  label: string;
  /** Synthetic WGS84 vertices (open ring — first point NOT repeated). */
  points: LatLng[];
  /**
   * Geodesic ground-truth area in square metres, computed with
   * geographiclib-geodesic's PolygonArea oracle.
   */
  geodesicAreaM2: number;
}

/**
 * Fixture 1 — Equatorial (0 °N / 0 °E, Null Island vicinity)
 *
 * Approximate dimensions: ~556 m (east-west) × ~445 m (north-south)
 * Geodesic area: 246 181 m²  (~24.6 ha)
 */
const equatorial: ReferencePolygon = {
  label: "equatorial (~0°N)",
  points: [
    { lat:  0.000, lng:  0.000 },
    { lat:  0.000, lng:  0.005 },
    { lat:  0.004, lng:  0.005 },
    { lat:  0.004, lng:  0.000 },
  ],
  geodesicAreaM2: 246_181.44,
};

/**
 * Fixture 2 — Mid latitude (19 °N, near Mumbai, India)
 *
 * Approximate dimensions: ~567 m (east-west) × ~556 m (north-south)
 * Geodesic area: 349 645 m²  (~35.0 ha)
 *
 * At this latitude cos(19°) ≈ 0.946, so Web Mercator would inflate east-west
 * distances by ~1/0.946 — an area error of ~12%, already exceeding the 1% spec.
 */
const midLatitude: ReferencePolygon = {
  label: "mid-latitude (~19°N, Mumbai area)",
  points: [
    { lat: 19.000, lng: 72.800 },
    { lat: 19.000, lng: 72.806 },
    { lat: 19.005, lng: 72.806 },
    { lat: 19.005, lng: 72.800 },
  ],
  geodesicAreaM2: 349_644.59,
};

/**
 * Fixture 3 — High latitude (53.48 °N, near Manchester, UK)
 *
 * Approximate dimensions: ~548 m (east-west) × ~668 m (north-south)
 * Geodesic area: 398 974 m²  (~39.9 ha)
 *
 * At this latitude cos(53.48°) ≈ 0.595, so Web Mercator inflates east-west
 * distances by ~1/0.595 ≈ 1.68 — an area error of ~(1/0.595)² − 1 ≈ 182%.
 * The negative-control test in projection.test.ts demonstrates this directly.
 */
const highLatitude: ReferencePolygon = {
  label: "high-latitude (~53.5°N, Manchester area)",
  points: [
    { lat: 53.480, lng: -2.240 },
    { lat: 53.480, lng: -2.231 },
    { lat: 53.486, lng: -2.231 },
    { lat: 53.486, lng: -2.240 },
  ],
  geodesicAreaM2: 398_974.01,
};

/** All three reference polygons, ordered equatorial → mid → high. */
export const REFERENCE_POLYGONS: ReferencePolygon[] = [
  equatorial,
  midLatitude,
  highLatitude,
];
