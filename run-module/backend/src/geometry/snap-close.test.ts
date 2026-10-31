/**
 * src/geometry/snap-close.test.ts
 *
 * Tests for snapClose() (RM-2.3).
 *
 * AC1 — 10 m gap → closed, length+1, last point === first point
 * AC2 — 60 m gap → not closed, reason='gap_exceeds_threshold', points unchanged
 * AC3 — boundary: ≈30 m gap closes, ≈31 m gap does not
 * AC4 — already-closed ring → closed=true, gapM=0, no duplicate vertex
 * AC5 — degenerate inputs (0,1,2,3 points) → closed=false, reason='insufficient_points'
 * AC6 — no mutation of input array
 * AC7 — determinism: same input → deep-equal results
 * AC8 — simplify.test.ts numbers unchanged (verified by running that suite)
 */

import { describe, it, expect } from "vitest";
import { snapClose } from "./snap-close.js";
import { generateNoisyTrack, SMOOTHED_TRACK_PROFILE } from "./__fixtures__/noisy-track.js";
import { createLocalProjection } from "./projection.js";
import { SNAP_CLOSE_MAX_GAP_M } from "./constants.js";
import type { LatLng } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Measure start-to-end gap in metres using AEQD projection. */
function measureGapM(points: LatLng[]): number {
  const proj = createLocalProjection(points);
  const a = proj.toPlanar(points[0]!);
  const b = proj.toPlanar(points[points.length - 1]!);
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

/** Generate a track whose endpoints are roughly `gapM` metres apart. */
function trackWithGap(gapM: number, seed = 42): LatLng[] {
  return generateNoisyTrack({
    seed,
    pointCount: 500,
    endGapM: gapM,
    ...SMOOTHED_TRACK_PROFILE,
  });
}

// ── AC1: 10 m gap closes ──────────────────────────────────────────────────────

describe("snapClose — AC1: closeable track (endGapM=10)", () => {
  it("returns closed=true, output length = input+1, last point === first", () => {
    const input = trackWithGap(10);
    const result = snapClose(input);

    expect(result.closed).toBe(true);
    if (!result.closed) throw new Error("narrowing");

    expect(result.points.length).toBe(input.length + 1);
    expect(result.points[result.points.length - 1]).toStrictEqual(result.points[0]);
    expect(result.points[result.points.length - 1]).toStrictEqual(input[0]);

    process.stdout.write(`  AC1 gapM=${result.gapM.toFixed(3)} m\n`);
    expect(result.gapM).toBeLessThanOrEqual(SNAP_CLOSE_MAX_GAP_M);
  });
});

// ── AC2: 60 m gap does NOT close ─────────────────────────────────────────────

describe("snapClose — AC2: non-closeable track (endGapM=60)", () => {
  it("returns closed=false, reason=gap_exceeds_threshold, points unchanged", () => {
    const input = trackWithGap(60);
    const result = snapClose(input);

    expect(result.closed).toBe(false);
    if (result.closed) throw new Error("narrowing");

    expect(result.reason).toBe("gap_exceeds_threshold");
    expect(result.points).toStrictEqual(input);

    process.stdout.write(`  AC2 gapM=${result.gapM.toFixed(3)} m\n`);
    expect(result.gapM).toBeGreaterThan(SNAP_CLOSE_MAX_GAP_M);
  });
});

// ── AC3: Boundary — ≈30 m closes, ≈31 m does not ────────────────────────────

describe("snapClose — AC3: boundary at SNAP_CLOSE_MAX_GAP_M", () => {
  it("endGapM=29 closes (gap well below 30 m)", () => {
    const input = trackWithGap(29, 1);
    const result = snapClose(input);

    process.stdout.write(`  AC3a (endGapM=29): measured gapM=${result.gapM.toFixed(3)} m, closed=${String(result.closed)}\n`);
    expect(result.closed).toBe(true);
    expect(result.gapM).toBeLessThanOrEqual(SNAP_CLOSE_MAX_GAP_M);
  });

  it("endGapM=31 does not close (gap above 30 m)", () => {
    const input = trackWithGap(31, 1);
    const result = snapClose(input);

    process.stdout.write(`  AC3b (endGapM=31): measured gapM=${result.gapM.toFixed(3)} m, closed=${String(result.closed)}\n`);
    expect(result.closed).toBe(false);
    expect(result.gapM).toBeGreaterThan(SNAP_CLOSE_MAX_GAP_M);
  });

  it("endGapM exactly at threshold (endGapM=30) closes (inclusive ≤)", () => {
    // The measured gap won't be exactly 30 m because noise moves the last
    // point, but the test confirms that tracks near the boundary behave
    // consistently. We test the boundary by calling snapClose with a custom
    // maxGapM equal to the measured gap, which must close.
    const input = trackWithGap(28, 5);
    const gapM = measureGapM(input);
    // Call snapClose with maxGapM = measured gap → must close (≤ inclusive)
    const result = snapClose(input, gapM);
    process.stdout.write(`  AC3c (inclusive): measured gapM=${gapM.toFixed(3)} m, maxGapM=${gapM.toFixed(3)}, closed=${String(result.closed)}\n`);
    expect(result.closed).toBe(true);
  });
});

// ── AC4: Already-closed ring ──────────────────────────────────────────────────

describe("snapClose — AC4: already-closed ring", () => {
  it("returns closed=true, gapM=0, does not duplicate the first vertex", () => {
    const open = trackWithGap(0);
    // Manually close it
    const closed = [...open, { ...open[0]! }];
    const result = snapClose(closed);

    expect(result.closed).toBe(true);
    if (!result.closed) throw new Error("narrowing");

    expect(result.gapM).toBe(0);
    // Length must stay the same — no extra point appended
    expect(result.points.length).toBe(closed.length);
  });
});

// ── AC5: Degenerate inputs ────────────────────────────────────────────────────

describe("snapClose — AC5: degenerate inputs", () => {
  const cases: [string, LatLng[]][] = [
    ["empty array", []],
    ["1 point", [{ lat: 19, lng: 72 }]],
    ["2 points", [{ lat: 19, lng: 72 }, { lat: 19.001, lng: 72.001 }]],
    [
      "3 points",
      [
        { lat: 19, lng: 72 },
        { lat: 19.001, lng: 72.001 },
        { lat: 19.002, lng: 72.002 },
      ],
    ],
  ];

  for (const [label, pts] of cases) {
    it(`${label} → closed=false, reason=insufficient_points`, () => {
      expect(() => snapClose(pts)).not.toThrow();
      const result = snapClose(pts);
      expect(result.closed).toBe(false);
      if (result.closed) throw new Error("narrowing");
      expect(result.reason).toBe("insufficient_points");
      expect(result.gapM).toBe(0);
    });
  }
});

// ── AC6: No mutation ──────────────────────────────────────────────────────────

describe("snapClose — AC6: no mutation of input", () => {
  it("input array is unchanged after a successful close", () => {
    const input = trackWithGap(10);
    const snapshot = input.map((p) => ({ ...p }));
    snapClose(input);
    expect(input).toStrictEqual(snapshot);
  });

  it("input array is unchanged after a failed close", () => {
    const input = trackWithGap(60);
    const snapshot = input.map((p) => ({ ...p }));
    snapClose(input);
    expect(input).toStrictEqual(snapshot);
  });
});

// ── AC7: Determinism ──────────────────────────────────────────────────────────

describe("snapClose — AC7: determinism", () => {
  it("same input produces deep-equal results on two calls", () => {
    const input = trackWithGap(10);
    const r1 = snapClose(input);
    const r2 = snapClose(input);
    expect(r1).toStrictEqual(r2);
  });
});

// ── Custom maxGapM ────────────────────────────────────────────────────────────

describe("snapClose — custom maxGapM", () => {
  it("honours a caller-supplied maxGapM override", () => {
    const input = trackWithGap(50); // gap ~50 m
    // Default 30 m → should not close
    expect(snapClose(input).closed).toBe(false);
    // Override to 100 m → should close
    const result = snapClose(input, 100);
    expect(result.closed).toBe(true);
  });
});
