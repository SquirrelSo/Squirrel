/**
 * src/geometry/projection.test.ts
 *
 * Tests for createLocalProjection():
 *   AC1  — planar area within 1% of geodesic ground truth at all latitudes
 *   AC2  — round-trip: toLatLng(toPlanar(p)) ≈ p within 1e-6°
 *   AC3  — negative control: Web Mercator area error EXCEEDS 1% at >50°N
 *   AC4  — determinism: identical input → byte-identical output
 *   AC5  — winding direction: CW and CCW produce the same area (area.test.ts)
 *   AC6  — typecheck / lint / test pass (enforced by CI)
 *
 * Web Mercator (EPSG:3857) appears ONLY in the negative-control test below.
 * It is not imported by any production file.
 */

import { describe, it, expect } from "vitest";
import proj4 from "proj4";
import { Geodesic } from "geographiclib-geodesic";
import { createLocalProjection, EmptyProjectionInputError, aeqdDefinitionFor } from "./projection.js";
import { planarAreaM2 } from "./area.js";
import { REFERENCE_POLYGONS } from "./__fixtures__/reference-polygons.js";
import type { LatLng, PlanarXY } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute geodesic area (m²) using geographiclib-geodesic as the oracle. */
function geodesicAreaM2(points: LatLng[]): number {
  const geod = Geodesic.WGS84;
  const poly = geod.Polygon(false);
  for (const p of points) poly.AddPoint(p.lat, p.lng);
  const result = poly.Compute(false, false);
  return Math.abs(result.area ?? 0);
}

/** Relative error as a percentage. */
function relErrPct(computed: number, reference: number): number {
  return (Math.abs(computed - reference) / reference) * 100;
}

// Web Mercator — used ONLY in the negative-control test, never in production.
const WGS84_DEF = "+proj=longlat +datum=WGS84 +no_defs";
const MERCATOR_DEF = "+proj=merc +datum=WGS84 +units=m +no_defs"; // EPSG:3857

function mercatorArea(points: LatLng[]): number {
  const fwd = proj4(WGS84_DEF, MERCATOR_DEF);
  const planar: PlanarXY[] = points.map((p) => {
    const result: number[] = fwd.forward([p.lng, p.lat]);
    return { x: result[0] ?? 0, y: result[1] ?? 0 };
  });
  return planarAreaM2(planar);
}

// ── AC1: Area accuracy across all latitudes ────────────────────────────────

describe("createLocalProjection — area accuracy", () => {
  for (const fixture of REFERENCE_POLYGONS) {
    it(`area within 1% of geodesic for: ${fixture.label}`, () => {
      const proj = createLocalProjection(fixture.points);
      const planar = fixture.points.map((p) => proj.toPlanar(p));
      const computed = planarAreaM2(planar);

      // Re-compute oracle at test time to guard against fixture typos
      const oracle = geodesicAreaM2(fixture.points);
      const errPct = relErrPct(computed, oracle);

      process.stdout.write(
        `  ${fixture.label}: computed=${computed.toFixed(2)} m², ` +
          `geodesic=${oracle.toFixed(2)} m², error=${errPct.toFixed(4)}%\n`
      );

      expect(errPct).toBeLessThan(1.0);
    });
  }
});

// ── AC2: Round-trip accuracy ───────────────────────────────────────────────

describe("createLocalProjection — round-trip (toPlanar → toLatLng)", () => {
  for (const fixture of REFERENCE_POLYGONS) {
    it(`round-trip within 1e-6° for: ${fixture.label}`, () => {
      const proj = createLocalProjection(fixture.points);
      for (const original of fixture.points) {
        const planar = proj.toPlanar(original);
        const recovered = proj.toLatLng(planar);
        expect(Math.abs(recovered.lat - original.lat)).toBeLessThan(1e-6);
        expect(Math.abs(recovered.lng - original.lng)).toBeLessThan(1e-6);
      }
    });
  }
});

// ── AC3: Negative control — Web Mercator exceeds 1% at high latitude ────────

describe("createLocalProjection — negative control (Web Mercator)", () => {
  it("Web Mercator area error EXCEEDS 1% for the high-latitude (>50°N) fixture", () => {
    // Use the last fixture (53.5°N — Manchester area)
    const fixture = REFERENCE_POLYGONS[REFERENCE_POLYGONS.length - 1]!;
    const oracle = geodesicAreaM2(fixture.points);
    const mercArea = mercatorArea(fixture.points);
    const errPct = relErrPct(mercArea, oracle);

    process.stdout.write(
      `  Mercator area at ${fixture.label}: computed=${mercArea.toFixed(2)} m², ` +
        `geodesic=${oracle.toFixed(2)} m², error=${errPct.toFixed(2)}%\n`
    );

    // Must be wrong by more than 1% — if this fails, Web Mercator is suspiciously accurate
    expect(errPct).toBeGreaterThan(1.0);
  });
});

// ── AC4: Determinism ──────────────────────────────────────────────────────

describe("createLocalProjection — determinism", () => {
  for (const fixture of REFERENCE_POLYGONS) {
    it(`byte-identical output on two runs for: ${fixture.label}`, () => {
      const proj1 = createLocalProjection(fixture.points);
      const proj2 = createLocalProjection(fixture.points);

      const coords1 = fixture.points.map((p) => proj1.toPlanar(p));
      const coords2 = fixture.points.map((p) => proj2.toPlanar(p));

      expect(coords1).toStrictEqual(coords2);
    });
  }
});

// ── Error handling ─────────────────────────────────────────────────────────

describe("createLocalProjection — error handling", () => {
  it("throws EmptyProjectionInputError for an empty array", () => {
    expect(() => createLocalProjection([])).toThrow(EmptyProjectionInputError);
    expect(() => createLocalProjection([])).toThrow(
      "createLocalProjection requires at least one point"
    );
  });

  it("succeeds with a single point (degenerate projection, valid call)", () => {
    const proj = createLocalProjection([{ lat: 51.5, lng: -0.12 }]);
    const p = proj.toPlanar({ lat: 51.5, lng: -0.12 });
    // At the exact centre, planar coords should be (0, 0)
    expect(Math.abs(p.x)).toBeLessThan(1e-6);
    expect(Math.abs(p.y)).toBeLessThan(1e-6);
  });
});

// ── AEQD definition string ─────────────────────────────────────────────────

describe("aeqdDefinitionFor", () => {
  it("returns the expected proj4 AEQD string", () => {
    const def = aeqdDefinitionFor({ lat: 53.483, lng: -2.2355 });
    expect(def).toContain("+proj=aeqd");
    expect(def).toContain("+lat_0=53.483");
    expect(def).toContain("+lon_0=-2.2355");
    expect(def).toContain("+datum=WGS84");
    expect(def).toContain("+units=m");
    expect(def).not.toContain("3857");
    expect(def).not.toContain("merc");
  });
});
