/**
 * src/geometry/simplify.test.ts
 *
 * Tests for simplifyPlanar / simplifyTrack / generateNoisyTrack / createPrng.
 *
 * AC1  — ≥80% point reduction on 2000-pt noisy track with epsilon=4m
 * AC2  — simplified area within 2% of original area
 * AC3  — first and last points preserved
 * AC4  — determinism of both generator and simplifier
 * AC5  — different seeds → different tracks
 * AC6  — monotonicity: larger epsilon → fewer or equal points
 * AC7  — degenerate inputs: empty, 1pt, 2pt, coincident run
 */

import { describe, it, expect } from "vitest";
import { simplifyPlanar, simplifyTrack } from "./simplify.js";
import {
  generateNoisyTrack,
  SMOOTHED_TRACK_PROFILE,
} from "./__fixtures__/noisy-track.js";
import { createPrng } from "./__fixtures__/prng.js";
import { createLocalProjection } from "./projection.js";
import { planarAreaM2 } from "./area.js";
import { SIMPLIFY_EPSILON_M } from "./constants.js";
import type { PlanarXY } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Close a ring for area comparison without mutating the original. */
function closeRing<T>(pts: T[]): T[] {
  if (pts.length === 0) return [];
  return [...pts, pts[0]!];
}

/** Relative error as a percentage. */
function relErrPct(computed: number, reference: number): number {
  return (Math.abs(computed - reference) / reference) * 100;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

/**
 * AC1 / AC2 fixture — 2 000 pts using SMOOTHED_TRACK_PROFILE (noiseStdDevM=1.5 m).
 *
 * SMOOTHED_TRACK_PROFILE is the canonical Phase 2 noise profile — it models
 * the Kalman-smoothed GPS residual the geometry pipeline receives after
 * RM-1.2 accuracy gating and RM-1.3 on-device smoothing.
 *
 * With noise=1.5 m and epsilon=4 m (ratio 0.375):
 *   DP achieves ~87.5 % reduction, area delta ~0.08 % — both within spec.
 * With RAW_GPS_TRACK_PROFILE (noise=3.0 m, ratio 0.75):
 *   DP retains ~45 % of points (~55 % reduction) — fails the 80 % floor.
 *
 * See docs/decisions/ADR-001-geometry-fixture-noise-profiles.md.
 */
const AC_TRACK = generateNoisyTrack({
  seed: 42,
  pointCount: 2000,
  ...SMOOTHED_TRACK_PROFILE, // canonical Phase 2 profile — see ADR-001
});

// ── AC1: ≥80% point reduction ────────────────────────────────────────────────

describe("simplifyTrack — AC1: point reduction", () => {
  it("reduces 2000-point track by at least 80% at epsilon=4m", () => {
    const before = AC_TRACK.length;
    const simplified = simplifyTrack(AC_TRACK, SIMPLIFY_EPSILON_M);
    const after = simplified.length;
    const reductionPct = ((before - after) / before) * 100;

    process.stdout.write(
      `  before=${before}  after=${after}  reduction=${reductionPct.toFixed(2)}%\n`
    );

    expect(reductionPct).toBeGreaterThanOrEqual(80);
  });
});

// ── AC2: area preserved within 2% ────────────────────────────────────────────

describe("simplifyTrack — AC2: area preservation", () => {
  it("planar area of simplified ring is within 2% of original ring", () => {
    const simplified = simplifyTrack(AC_TRACK, SIMPLIFY_EPSILON_M);

    const proj = createLocalProjection(AC_TRACK);

    const originalPlanar = AC_TRACK.map((p) => proj.toPlanar(p));
    const simplifiedPlanar = simplified.map((p) => proj.toPlanar(p));

    const originalArea = planarAreaM2(closeRing(originalPlanar));
    const simplifiedArea = planarAreaM2(closeRing(simplifiedPlanar));
    const errPct = relErrPct(simplifiedArea, originalArea);

    process.stdout.write(
      `  originalArea=${originalArea.toFixed(2)} m²  ` +
        `simplifiedArea=${simplifiedArea.toFixed(2)} m²  ` +
        `areaDelta=${errPct.toFixed(4)}%\n`
    );

    expect(errPct).toBeLessThan(2.0);
  });
});

// ── AC3: first and last points preserved ────────────────────────────────────

describe("simplifyPlanar — AC3: endpoint preservation", () => {
  it("preserves first and last points of the input", () => {
    const track = generateNoisyTrack({ pointCount: 500 });
    const proj = createLocalProjection(track);
    const planar = track.map((p) => proj.toPlanar(p));

    const simplified = simplifyPlanar(planar, SIMPLIFY_EPSILON_M);

    expect(simplified[0]).toStrictEqual(planar[0]);
    expect(simplified[simplified.length - 1]).toStrictEqual(
      planar[planar.length - 1]
    );
  });
});

// ── AC4: determinism ──────────────────────────────────────────────────────────

describe("determinism — AC4", () => {
  it("generateNoisyTrack with same seed produces identical arrays", () => {
    const a = generateNoisyTrack({ seed: 42 });
    const b = generateNoisyTrack({ seed: 42 });
    expect(a).toStrictEqual(b);
  });

  it("simplifyPlanar with same input produces identical output", () => {
    const track = generateNoisyTrack({ seed: 7, pointCount: 500 });
    const proj = createLocalProjection(track);
    const planar = track.map((p) => proj.toPlanar(p));

    const r1 = simplifyPlanar(planar, SIMPLIFY_EPSILON_M);
    const r2 = simplifyPlanar(planar, SIMPLIFY_EPSILON_M);
    expect(r1).toStrictEqual(r2);
  });
});

// ── AC5: different seeds → different tracks ──────────────────────────────────

describe("generateNoisyTrack — AC5: seed sensitivity", () => {
  it("different seeds produce different tracks", () => {
    const a = generateNoisyTrack({ seed: 1 });
    const b = generateNoisyTrack({ seed: 2 });
    // At minimum, some points must differ
    const anyDifferent = a.some(
      (p, i) => p.lat !== b[i]?.lat || p.lng !== b[i]?.lng
    );
    expect(anyDifferent).toBe(true);
  });
});

// ── AC6: monotonicity ─────────────────────────────────────────────────────────

describe("simplifyPlanar — AC6: monotonicity (larger ε → fewer or equal points)", () => {
  it("epsilon 1m produces ≥ points as epsilon 4m, which produces ≥ points as 10m", () => {
    const track = generateNoisyTrack({ seed: 99, pointCount: 1000 });
    const proj = createLocalProjection(track);
    const planar = track.map((p) => proj.toPlanar(p));

    const n1 = simplifyPlanar(planar, 1).length;
    const n4 = simplifyPlanar(planar, 4).length;
    const n10 = simplifyPlanar(planar, 10).length;

    process.stdout.write(`  ε=1m→${n1}pts  ε=4m→${n4}pts  ε=10m→${n10}pts\n`);

    expect(n1).toBeGreaterThanOrEqual(n4);
    expect(n4).toBeGreaterThanOrEqual(n10);
  });
});

// ── AC7: degenerate inputs ────────────────────────────────────────────────────

describe("simplifyPlanar — AC7: degenerate inputs", () => {
  it("empty array returns empty array", () => {
    expect(simplifyPlanar([], 4)).toStrictEqual([]);
  });

  it("single point returns single point", () => {
    const pts: PlanarXY[] = [{ x: 1, y: 2 }];
    expect(simplifyPlanar(pts, 4)).toStrictEqual([{ x: 1, y: 2 }]);
  });

  it("two points returns both points unchanged", () => {
    const pts: PlanarXY[] = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
    expect(simplifyPlanar(pts, 4)).toStrictEqual(pts);
  });

  it("run of coincident points does not throw and returns 2 points", () => {
    const pts: PlanarXY[] = Array.from({ length: 50 }, () => ({ x: 5, y: 5 }));
    expect(() => simplifyPlanar(pts, 4)).not.toThrow();
    // All coincident → all within epsilon of start-end line → collapses to 2
    const result = simplifyPlanar(pts, 4);
    expect(result.length).toBe(2);
  });

  it("all points within epsilon of the start-end line reduces to exactly 2 points", () => {
    // Perfectly collinear points with tiny jitter — all within 1m of the line
    const pts: PlanarXY[] = Array.from({ length: 100 }, (_, i) => ({
      x: i * 10,
      y: 0.5 * Math.sin(i), // max deviation = 0.5m, well below epsilon=4m
    }));
    const result = simplifyPlanar(pts, 4);
    expect(result.length).toBe(2);
    expect(result[0]).toStrictEqual(pts[0]);
    expect(result[result.length - 1]).toStrictEqual(pts[pts.length - 1]);
  });

  it("very large epsilon still returns at least 2 points", () => {
    const track = generateNoisyTrack({ seed: 5, pointCount: 200 });
    const proj = createLocalProjection(track);
    const planar = track.map((p) => proj.toPlanar(p));
    const result = simplifyPlanar(planar, 1_000_000);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

// ── PRNG sanity ───────────────────────────────────────────────────────────────

describe("createPrng — basic properties", () => {
  it("produces values in [0, 1)", () => {
    const prng = createPrng(12345);
    for (let i = 0; i < 1000; i++) {
      const v = prng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("same seed produces same sequence", () => {
    const p1 = createPrng(99);
    const p2 = createPrng(99);
    for (let i = 0; i < 20; i++) {
      expect(p1.next()).toBe(p2.next());
    }
  });

  it("different seeds produce different sequences", () => {
    const p1 = createPrng(1);
    const p2 = createPrng(2);
    const anyDiff = Array.from({ length: 20 }, () => [p1.next(), p2.next()]).some(
      ([a, b]) => a !== b
    );
    expect(anyDiff).toBe(true);
  });
});
