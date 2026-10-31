/**
 * src/geometry/__fixtures__/noisy-track.ts
 *
 * Generates a synthetic GPS-like noisy track for geometry pipeline tests.
 *
 * ALL COORDINATES ARE SYNTHETIC — no real GPS data, no real user locations.
 *
 * ════════════════════════════════════════════════════════════════════════
 * CANONICAL PROFILE FOR PHASE 2: SMOOTHED_TRACK_PROFILE (noiseStdDevM=1.5)
 *
 * Every Phase 2 ticket uses the SMOOTHED_TRACK_PROFILE unless it explicitly
 * states otherwise. Rationale: RM-1.2 filters out points with accuracy >20 m
 * and RM-1.3 applies Kalman smoothing ON DEVICE before any point reaches
 * this geometry pipeline. Raw 3 m iid jitter (RAW_GPS_TRACK_PROFILE) models
 * unsmoothed GPS, which this code never receives. ~1.5 m residual models the
 * smoothed input it actually receives. See ADR-001 for the full decision.
 * ════════════════════════════════════════════════════════════════════════
 *
 * The generator:
 *   1. Lays down an ideal circular loop in PROJECTED planar space.
 *   2. Adds per-point Gaussian jitter (Box–Muller over the seeded PRNG).
 *   3. Optionally leaves a straight-line gap between the last generated
 *      point and the first (endGapM option — used by snap-close tests).
 *   4. Unprojects back to WGS84 lat/lng.
 *
 * Fully deterministic for a given seed — the same options always produce
 * the same array. Math.random() is forbidden.
 *
 * The track is an OPEN ring (first point not repeated at the end).
 * Closing the ring is RM-2.3's responsibility (snapClose).
 */

import { createLocalProjection } from "../projection.js";
import { createPrng } from "./prng.js";
import type { LatLng } from "../types.js";

// ── Noise profiles ────────────────────────────────────────────────────────────

/**
 * CANONICAL Phase 2 noise profile.
 *
 * noiseStdDevM = 1.5 m — models the Kalman-smoothed GPS residual that
 * the geometry pipeline actually receives (after RM-1.2 accuracy gating
 * and RM-1.3 on-device smoothing).
 *
 * All Phase 2 tests use this profile unless explicitly noted otherwise.
 * See ADR-001 for the full justification.
 */
export const SMOOTHED_TRACK_PROFILE = { noiseStdDevM: 1.5 } as const;

/**
 * Raw GPS noise profile — for stress tests and worst-case analysis ONLY.
 *
 * noiseStdDevM = 3.0 m — models raw, unsmoothed GPS output.
 * This is NOT representative of what this pipeline receives.
 * With epsilon=4 m, DP retains ~45 % of points — below the 80 % spec
 * floor. Never use this as the default in Phase 2 tests.
 */
export const RAW_GPS_TRACK_PROFILE = { noiseStdDevM: 3.0 } as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NoisyTrackOptions {
  /**
   * PRNG seed for reproducibility. Default: 42.
   * Different seeds produce different tracks.
   */
  seed?: number;
  /**
   * Total number of points in the output. Default: 2000.
   * Points are distributed evenly around the circular template.
   */
  pointCount?: number;
  /**
   * Geographic centre of the loop. Default: mid-latitude Mumbai area
   * (lat=19.0025, lng=72.803 — matches the RM-2.1 midLatitude fixture).
   */
  centre?: LatLng;
  /**
   * Radius of the ideal circular loop in metres. Default: 150 m.
   * Diameter ~300 m → area ≈ 70 686 m² — realistic running territory.
   */
  radiusM?: number;
  /**
   * Standard deviation of per-point Gaussian noise in metres.
   * Default: SMOOTHED_TRACK_PROFILE.noiseStdDevM (1.5 m).
   *
   * Use SMOOTHED_TRACK_PROFILE for Phase 2 canonical tests.
   * Use RAW_GPS_TRACK_PROFILE only for stress / worst-case tests.
   */
  noiseStdDevM?: number;
  /**
   * Straight-line gap in metres between the last generated point and
   * the first point of the track. Default: 0 (ideal closed loop with
   * only noise, no deliberate gap).
   *
   * When > 0, the final point of the output is shifted along the radial
   * direction away from the ideal closing position, leaving a controlled
   * gap so snap-close tests can produce both closeable and non-closeable
   * tracks deterministically from the same generator.
   *
   * Edge case: if endGapM > radiusM*2, the final point may lie outside
   * the general track area, but the track remains valid for gap-testing.
   */
  endGapM?: number;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CENTRE: LatLng = { lat: 19.0025, lng: 72.803 };

// ── Box–Muller transform ──────────────────────────────────────────────────────

/**
 * Produce a pair of independent standard-normal samples using the
 * Box–Muller transform over the supplied PRNG.
 *
 * Returns [z0, z1] where each z ~ N(0,1).
 *
 * Degenerate case: if u1 is 0 (probability 1/2^32 with mulberry32),
 * substitute u1 = Number.EPSILON to avoid log(0).
 */
function boxMullerPair(next: () => number): [number, number] {
  const u1 = next() || Number.EPSILON; // guard against log(0)
  const u2 = next();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a synthetic noisy GPS track.
 *
 * @param options - Generation options (all optional, see NoisyTrackOptions).
 *                  Use SMOOTHED_TRACK_PROFILE for Phase 2 canonical tests.
 * @returns An open ring of WGS84 coordinates in walk order (first point NOT
 *          repeated at the end unless the track naturally closes via noise).
 */
export function generateNoisyTrack(options: NoisyTrackOptions = {}): LatLng[] {
  const seed = options.seed ?? 42;
  const pointCount = options.pointCount ?? 2000;
  const centre = options.centre ?? DEFAULT_CENTRE;
  const radiusM = options.radiusM ?? 150;
  const noiseStdDevM = options.noiseStdDevM ?? SMOOTHED_TRACK_PROFILE.noiseStdDevM;
  const endGapM = options.endGapM ?? 0;

  // Build a single-point projection centred on the track centre.
  const proj = createLocalProjection([centre]);
  const prng = createPrng(seed);

  const result: LatLng[] = [];

  // Pre-generate all Gaussian noise values in pairs (Box–Muller produces 2 per call).
  // Sequential generation ensures iteration order is deterministic.
  const noiseX = new Float64Array(pointCount);
  const noiseY = new Float64Array(pointCount);
  for (let i = 0; i < pointCount; i += 2) {
    const [z0, z1] = boxMullerPair(prng.next.bind(prng));
    noiseX[i] = z0 * noiseStdDevM;
    noiseY[i] = z1 * noiseStdDevM;
    if (i + 1 < pointCount) {
      const [z2, z3] = boxMullerPair(prng.next.bind(prng));
      noiseX[i + 1] = z2 * noiseStdDevM;
      noiseY[i + 1] = z3 * noiseStdDevM;
    }
  }

  for (let i = 0; i < pointCount; i++) {
    // Ideal circular position, evenly spaced (no randomness in angle)
    const angle = (2 * Math.PI * i) / pointCount;
    const idealX = radiusM * Math.cos(angle);
    const idealY = radiusM * Math.sin(angle);

    // Apply Gaussian jitter in planar space
    let noisedX = idealX + (noiseX[i] ?? 0);
    let noisedY = idealY + (noiseY[i] ?? 0);

    // Apply the end-gap offset to the LAST point only.
    // Shift the last point radially outward (away from the first point at
    // angle=0) by endGapM metres, creating a controllable start-to-end gap.
    // The first point is at approximately (radiusM, 0) in planar space;
    // moving the last point further along the same radial direction
    // (angle ≈ 2π, i.e. direction +x) separates the endpoints by endGapM.
    if (endGapM > 0 && i === pointCount - 1) {
      // The last ideal point is at angle ≈ (2π*(n-1)/n) ≈ 2π ≈ 0 radians.
      // The unit vector pointing from pt[n-1] toward pt[0] is approximately
      // (-cos(angle), -sin(angle)). We move AWAY from pt[0], i.e. add
      // endGapM in the direction (cos(angle), sin(angle)).
      noisedX += endGapM * Math.cos(angle);
      noisedY += endGapM * Math.sin(angle);
    }

    result.push(proj.toLatLng({ x: noisedX, y: noisedY }));
  }

  return result;
}
