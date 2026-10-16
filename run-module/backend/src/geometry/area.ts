/**
 * src/geometry/area.ts
 *
 * Planar area measurement via the Shoelace formula (Gauss's area formula).
 *
 * Operates on local planar coordinates in metres (PlanarXY), so the result is
 * in square metres.  Input must already have been projected by createLocalProjection()
 * before being passed here.
 *
 * Both winding directions (CW and CCW) return the same positive area.
 * A closed ring (first point repeated as last) is handled identically to an open ring.
 * Fewer than 3 distinct points return 0 rather than throwing.
 */

import type { PlanarXY } from "./types.js";

/**
 * Compute the area of a planar polygon using the Shoelace formula.
 *
 * @param points - Array of planar (metre) coordinates.  May be open or closed
 *                 (last point equal to first).  Must have ≥ 3 points for a
 *                 non-zero result.
 * @returns Absolute area in square metres.  Never negative.
 */
export function planarAreaM2(points: readonly PlanarXY[]): number {
  // Strip a closing point if present (last === first) to avoid double-counting.
  const ring: readonly PlanarXY[] =
    points.length > 1 &&
    points[0] !== undefined &&
    points[points.length - 1] !== undefined &&
    points[0].x === points[points.length - 1]!.x &&
    points[0].y === points[points.length - 1]!.y
      ? points.slice(0, -1)
      : points;

  if (ring.length < 3) return 0;

  // Shoelace: Σ (x_i * y_{i+1} - x_{i+1} * y_i)
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const curr = ring[i]!;
    const next = ring[(i + 1) % n]!;
    sum += curr.x * next.y - next.x * curr.y;
  }

  return Math.abs(sum) / 2;
}
