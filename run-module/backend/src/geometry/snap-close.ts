/**
 * src/geometry/snap-close.ts
 *
 * Snap-close: decides whether a GPS track forms a closed loop.
 *
 * This is a TRUST BOUNDARY, not a convenience.  Force-closing a track
 * with a large start-to-end gap would manufacture enclosed area the runner
 * never actually ran.  Gaps above the threshold are flagged and returned
 * unchanged; the caller (RM-2.5 validation) converts the flag into a
 * rejection reason code.
 *
 * The gap is always measured in projected METRES via AEQD — never in
 * degrees (a degree of longitude represents a different distance at every
 * latitude).
 *
 * NOTE — Antimeridian: tracks whose start and end points span the
 * antimeridian (+/-180°) may produce an incorrect gap measurement because
 * the AEQD projection is centred on the centroid of all input points and
 * may place the two endpoints far apart in planar space.
 * TODO: detect antimeridian-spanning inputs and return a typed error
 * rather than a silently wrong gap value (RM-future).
 */

import { createLocalProjection } from "./projection.js";
import { SNAP_CLOSE_MAX_GAP_M } from "./constants.js";
import type { LatLng } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SnapCloseResult =
  | {
      /** The track was successfully closed into a ring. */
      closed: true;
      /** The closed ring: original points + first point appended as last. */
      points: LatLng[];
      /** Measured start-to-end gap in metres (0 if already closed). */
      gapM: number;
    }
  | {
      /** The track was NOT closed — gap exceeds threshold or too few points. */
      closed: false;
      /** The original points, unmodified. */
      points: LatLng[];
      /** Measured start-to-end gap in metres (0 for insufficient_points). */
      gapM: number;
      reason: "gap_exceeds_threshold" | "insufficient_points";
    };

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Euclidean distance in planar metres between two points. */
function planarDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to close a GPS track into a ring.
 *
 * @param points  - Input WGS84 track (open or already-closed ring).
 *                  This array is NEVER mutated.
 * @param maxGapM - Maximum allowed start-to-end gap in metres (inclusive).
 *                  Defaults to SNAP_CLOSE_MAX_GAP_M (30 m).
 * @returns SnapCloseResult — see type definition for all variants.
 */
export function snapClose(
  points: readonly LatLng[],
  maxGapM: number = SNAP_CLOSE_MAX_GAP_M
): SnapCloseResult {
  // Fewer than 4 distinct points cannot form a valid closed polygon.
  if (points.length < 4) {
    return {
      closed: false,
      points: [...points],
      gapM: 0,
      reason: "insufficient_points",
    };
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;

  // Already-closed: last point equals first — treat as gapM=0, closed=true.
  // Use strict coordinate equality (the only way the ring can already be
  // closed is if a caller previously appended the first point).
  if (first.lat === last.lat && first.lng === last.lng) {
    return {
      closed: true,
      points: [...points], // copy — do not append a duplicate
      gapM: 0,
    };
  }

  // Measure the gap in projected metres.
  // Project all points so the AEQD centre is the centroid of the full track,
  // not just the two endpoints — this matches how the rest of the pipeline
  // uses projection.
  const proj = createLocalProjection(points);
  const planarFirst = proj.toPlanar(first);
  const planarLast = proj.toPlanar(last);
  const gapM = planarDistance(
    planarFirst.x,
    planarFirst.y,
    planarLast.x,
    planarLast.y
  );

  if (gapM > maxGapM) {
    return {
      closed: false,
      points: [...points], // unchanged — no force-close
      gapM,
      reason: "gap_exceeds_threshold",
    };
  }

  // Gap is within threshold: close by appending a COPY of the first point.
  // Do not average the endpoints; no unobserved coordinate enters the output.
  return {
    closed: true,
    points: [...points, { ...first }],
    gapM,
  };
}
