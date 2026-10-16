/**
 * src/geometry/area.test.ts
 *
 * Tests for planarAreaM2():
 *   AC5  — CW and CCW windings produce the same absolute area
 *   —     degenerate inputs (< 3 points → 0)
 *   —     closed ring handled identically to open ring
 *   —     known simple shapes (unit square, triangle)
 */

import { describe, it, expect } from "vitest";
import { planarAreaM2 } from "./area.js";
import type { PlanarXY } from "./types.js";

// ── Known shapes ─────────────────────────────────────────────────────────────

describe("planarAreaM2 — known shapes", () => {
  it("computes correct area for a 1×1 unit square (CCW)", () => {
    const square: PlanarXY[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(planarAreaM2(square)).toBeCloseTo(1.0, 10);
  });

  it("computes correct area for a 100m × 200m rectangle", () => {
    const rect: PlanarXY[] = [
      { x:   0, y:   0 },
      { x: 100, y:   0 },
      { x: 100, y: 200 },
      { x:   0, y: 200 },
    ];
    expect(planarAreaM2(rect)).toBeCloseTo(20_000, 6);
  });

  it("computes correct area for a right triangle (base 300m, height 400m)", () => {
    const triangle: PlanarXY[] = [
      { x:   0, y:   0 },
      { x: 300, y:   0 },
      { x:   0, y: 400 },
    ];
    // Area = 0.5 * 300 * 400 = 60 000 m²
    expect(planarAreaM2(triangle)).toBeCloseTo(60_000, 6);
  });
});

// ── AC5: Winding direction ────────────────────────────────────────────────────

describe("planarAreaM2 — winding direction (AC5)", () => {
  const ccw: PlanarXY[] = [
    { x:   0, y:   0 },
    { x: 500, y:   0 },
    { x: 500, y: 400 },
    { x:   0, y: 400 },
  ];
  const cw: PlanarXY[] = [...ccw].reverse();

  it("CCW and CW windings return the same area", () => {
    const areaCCW = planarAreaM2(ccw);
    const areaCW  = planarAreaM2(cw);
    expect(areaCCW).toBeCloseTo(areaCW, 10);
    expect(areaCCW).toBeCloseTo(200_000, 6);
  });
});

// ── Closed ring ───────────────────────────────────────────────────────────────

describe("planarAreaM2 — closed ring", () => {
  const open: PlanarXY[] = [
    { x:   0, y:   0 },
    { x: 400, y:   0 },
    { x: 400, y: 300 },
    { x:   0, y: 300 },
  ];
  const closed: PlanarXY[] = [...open, { x: 0, y: 0 }]; // last === first

  it("closed ring gives the same area as open ring", () => {
    expect(planarAreaM2(open)).toBeCloseTo(planarAreaM2(closed), 10);
  });
});

// ── Degenerate inputs ─────────────────────────────────────────────────────────

describe("planarAreaM2 — degenerate inputs", () => {
  it("returns 0 for an empty array", () => {
    expect(planarAreaM2([])).toBe(0);
  });

  it("returns 0 for a single point", () => {
    expect(planarAreaM2([{ x: 1, y: 2 }])).toBe(0);
  });

  it("returns 0 for two points (a line segment)", () => {
    expect(planarAreaM2([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBe(0);
  });

  it("returns 0 for a collinear triple", () => {
    // All three on the x-axis — no area
    const collinear: PlanarXY[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ];
    expect(planarAreaM2(collinear)).toBeCloseTo(0, 10);
  });
});
