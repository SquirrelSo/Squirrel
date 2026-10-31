/**
 * src/geometry/simplify.ts
 *
 * Douglas–Peucker polyline simplification operating in planar metres.
 *
 * Key invariants:
 *   - First and last points are always retained.
 *   - Output order matches input order.
 *   - No library dependency — implemented directly for deterministic output.
 *   - Coincident endpoints are handled without division by zero.
 *   - ≤ 2 input points are returned unchanged.
 *   - Output always contains ≥ 2 points (for non-empty inputs with ≥ 2 points).
 *
 * The convenience wrapper `simplifyTrack` handles the project→simplify→unproject
 * round-trip so callers that work in WGS84 don't need to manage the projection.
 */

import { createLocalProjection } from "./projection.js";
import { SIMPLIFY_EPSILON_M } from "./constants.js";
import type { LatLng, PlanarXY } from "./types.js";

// ── Geometry helpers ──────────────────────────────────────────────────────────

/**
 * Perpendicular distance from point `p` to the line segment defined by
 * endpoints `a` and `b`, in the same units as the coordinates.
 *
 * When a === b (coincident endpoints), falls back to the Euclidean
 * point-to-point distance from p to a, avoiding division by zero.
 */
function perpendicularDistance(
  p: PlanarXY,
  a: PlanarXY,
  b: PlanarXY
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    // Coincident endpoints — use point-to-point distance
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }

  // Signed area of the triangle (p, a, b) × 2, divided by base length
  // = |cross(b-a, p-a)| / |b-a|
  const cross = Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy);
  return cross / Math.sqrt(lenSq);
}

// ── Core algorithm ────────────────────────────────────────────────────────────

/**
 * Recursive Douglas–Peucker step.
 *
 * Marks indices that should be kept in the `keep` boolean array.
 * `start` and `end` are inclusive indices into `points`.
 *
 * Iteration order is deterministic: always find the farthest point
 * between `start` and `end`, recurse left then right.
 */
function dpRecurse(
  points: readonly PlanarXY[],
  start: number,
  end: number,
  epsilonM: number,
  keep: boolean[]
): void {
  if (end <= start + 1) return; // no interior points to evaluate

  const a = points[start]!;
  const b = points[end]!;

  let maxDist = 0;
  let maxIdx = start;

  for (let i = start + 1; i < end; i++) {
    const d = perpendicularDistance(points[i]!, a, b);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilonM) {
    keep[maxIdx] = true;
    dpRecurse(points, start, maxIdx, epsilonM, keep);
    dpRecurse(points, maxIdx, end, epsilonM, keep);
  }
  // If maxDist <= epsilonM, all interior points are dropped (keep stays false)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Simplify a polyline of planar coordinates using the Douglas–Peucker algorithm.
 *
 * @param points  - Input polyline in planar metres (PlanarXY[]).
 * @param epsilonM - Tolerance in metres. Points within this distance of the
 *                   line between the current endpoints are dropped.
 * @returns A simplified polyline.  Always retains first and last points.
 *          Returns input unchanged for ≤ 2 points.
 */
export function simplifyPlanar(
  points: readonly PlanarXY[],
  epsilonM: number
): PlanarXY[] {
  if (points.length <= 2) return [...points];

  const n = points.length;
  const keep = new Array<boolean>(n).fill(false);

  // Always keep first and last
  keep[0] = true;
  keep[n - 1] = true;

  dpRecurse(points, 0, n - 1, epsilonM, keep);

  return points.filter((_, i) => keep[i]);
}

/**
 * Project a WGS84 track to planar metres, simplify, then unproject back.
 *
 * This is the high-level entry point for callers working in lat/lng space.
 *
 * @param points   - Input WGS84 track (open or closed ring).
 * @param epsilonM - Tolerance in metres. Defaults to SIMPLIFY_EPSILON_M (4 m).
 * @returns Simplified WGS84 track.
 */
export function simplifyTrack(
  points: readonly LatLng[],
  epsilonM: number = SIMPLIFY_EPSILON_M
): LatLng[] {
  if (points.length <= 2) return [...points];

  const proj = createLocalProjection(points);
  const planar = points.map((p) => proj.toPlanar(p));
  const simplified = simplifyPlanar(planar, epsilonM);
  return simplified.map((p) => proj.toLatLng(p));
}
