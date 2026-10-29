/**
 * src/geometry/polygonize.test.ts
 *
 * Tests for polygonizeTrack() — RM-2.4 / RM-2.4a.
 *
 * Part A (RM-2.4a): fixtures now have default noise (1.5 m) and rotation
 * (23°).  A 0.00% area delta would mean noise/rotation are NOT being
 * applied and should be treated as a test failure, not a pass.
 *
 * AC1 — FIGURE-EIGHT (noisy, rotated): 2 faces, areas within 5% of ideal
 * AC2 — OUT-AND-BACK (noisy, rotated): 1 face, area within 5% of ideal
 * AC3 — SIMPLE LOOP (noisy, rotated): 1 face, area within 3% of ideal
 * AC4 — OPEN TRACK: ok=false reason=not_closed (no DB query)
 * AC5 — MULTIPOLYGON: valid SRID 4326, NumGeometries=faces.length
 * AC6 — DETERMINISM: same input → deep-equal result on two runs
 * AC7 — NOISY FIGURE-EIGHT: produces MORE than 2 faces; two largest dominate
 *
 * Database tests skip cleanly when DATABASE_URL is not set.
 */

import { describe, it, expect } from "vitest";
import { polygonizeTrack } from "./polygonize.js";
import {
  generateSimpleLoop,
  generateFigureEight,
  generateOutAndBack,
  generateOpenTrack,
  generateNoisyFigureEight,
  SIMPLE_LOOP_EXPECTED_FACES,
  SIMPLE_LOOP_AREA_M2,
  FIGURE_EIGHT_EXPECTED_FACES,
  FIGURE_EIGHT_RIGHT_AREA_M2,
  FIGURE_EIGHT_LEFT_AREA_M2,
  FIGURE_EIGHT_TOTAL_AREA_M2,
  OUT_AND_BACK_EXPECTED_FACES,
  OUT_AND_BACK_LOOP_AREA_M2,
  NOISY_FIGURE_EIGHT_DOMINANT_FACES,
} from "./__fixtures__/shape-tracks.js";

// ── Database availability guard ───────────────────────────────────────────────

const HAS_DB = typeof process.env["DATABASE_URL"] === "string" &&
  process.env["DATABASE_URL"].length > 0;

function dbIt(
  name: string,
  fn: () => Promise<void> | void
): ReturnType<typeof it> {
  return HAS_DB ? it(name, fn) : it.skip(`[no DATABASE_URL] ${name}`);
}

// ── AC4: open track never queries the DB ──────────────────────────────────────

describe("polygonizeTrack — AC4: open track", () => {
  it("returns ok=false reason=not_closed without a database query", async () => {
    const track = generateOpenTrack();
    const result = await polygonizeTrack(track);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.reason).toBe("not_closed");
    expect(result.faces).toStrictEqual([]);
  });
});

// ── AC1: figure-eight ─────────────────────────────────────────────────────────

describe(`polygonizeTrack — AC1: figure-eight (noisy + rotated, requires DB)`, () => {
  dbIt(`produces exactly ${FIGURE_EIGHT_EXPECTED_FACES} faces, areas within 5% of ideal`, async () => {
    // Default opts: noiseStdDevM=1.5, rotationDeg=23
    const track = generateFigureEight();
    const result = await polygonizeTrack(track);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrowing");

    process.stdout.write(`  figure-eight faces: ${result.faces.length}\n`);
    result.faces.forEach((f, i) => {
      process.stdout.write(`    face[${i}]: area=${f.areaM2.toFixed(2)} m²\n`);
    });

    expect(result.faces.length).toBe(FIGURE_EIGHT_EXPECTED_FACES);

    // Faces are sorted area-descending: face[0]=right lobe, face[1]=left lobe
    const bigArea   = result.faces[0]!.areaM2;
    const smallArea = result.faces[1]!.areaM2;

    const bigDelta   = Math.abs(bigArea   - FIGURE_EIGHT_RIGHT_AREA_M2) / FIGURE_EIGHT_RIGHT_AREA_M2 * 100;
    const smallDelta = Math.abs(smallArea - FIGURE_EIGHT_LEFT_AREA_M2)  / FIGURE_EIGHT_LEFT_AREA_M2  * 100;
    const totalDelta = Math.abs(result.totalAreaM2 - FIGURE_EIGHT_TOTAL_AREA_M2) / FIGURE_EIGHT_TOTAL_AREA_M2 * 100;

    process.stdout.write(
      `  right lobe: ${bigArea.toFixed(2)} m² (ideal ${FIGURE_EIGHT_RIGHT_AREA_M2} m², delta=${bigDelta.toFixed(3)}%)\n` +
      `  left  lobe: ${smallArea.toFixed(2)} m² (ideal ${FIGURE_EIGHT_LEFT_AREA_M2} m², delta=${smallDelta.toFixed(3)}%)\n` +
      `  total: ${result.totalAreaM2.toFixed(2)} m² (ideal ${FIGURE_EIGHT_TOTAL_AREA_M2} m², delta=${totalDelta.toFixed(3)}%)\n`
    );

    // Non-zero delta confirms noise/rotation are being applied
    expect(bigDelta,   "delta must be > 0 — noise/rotation must be applied").toBeGreaterThan(0);
    expect(smallDelta, "delta must be > 0 — noise/rotation must be applied").toBeGreaterThan(0);

    expect(bigDelta).toBeLessThan(5);
    expect(smallDelta).toBeLessThan(5);

    // Verify face validity via PostGIS
    const { pool } = await import("../db/pool.js");
    for (const face of result.faces) {
      const vr = await pool.query<{ is_valid: boolean }>(
        "SELECT ST_IsValid(ST_GeomFromText($1, 4326)) AS is_valid",
        [face.wkt4326]
      );
      expect(vr.rows[0]?.is_valid).toBe(true);
    }
  });
});

// ── AC2: out-and-back ─────────────────────────────────────────────────────────

describe("polygonizeTrack — AC2: out-and-back (noisy + rotated, requires DB)", () => {
  dbIt(`produces exactly ${OUT_AND_BACK_EXPECTED_FACES} face, area within 5% of ideal`, async () => {
    const track = generateOutAndBack();
    const result = await polygonizeTrack(track);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrowing");

    expect(result.faces.length).toBe(OUT_AND_BACK_EXPECTED_FACES);

    const area = result.faces[0]!.areaM2;
    const delta = Math.abs(area - OUT_AND_BACK_LOOP_AREA_M2) / OUT_AND_BACK_LOOP_AREA_M2 * 100;
    process.stdout.write(
      `  out-and-back area=${area.toFixed(2)} m² (ideal ${OUT_AND_BACK_LOOP_AREA_M2} m², delta=${delta.toFixed(3)}%)\n`
    );

    expect(delta, "delta must be > 0 — noise/rotation must be applied").toBeGreaterThan(0);
    expect(delta).toBeLessThan(5);
  });
});

// ── AC3: simple loop ──────────────────────────────────────────────────────────

describe("polygonizeTrack — AC3: simple loop (noisy + rotated, requires DB)", () => {
  dbIt(`produces exactly ${SIMPLE_LOOP_EXPECTED_FACES} face, area within 3% of ideal`, async () => {
    const track = generateSimpleLoop();
    const result = await polygonizeTrack(track);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrowing");

    expect(result.faces.length).toBe(SIMPLE_LOOP_EXPECTED_FACES);

    const area = result.faces[0]!.areaM2;
    const delta = Math.abs(area - SIMPLE_LOOP_AREA_M2) / SIMPLE_LOOP_AREA_M2 * 100;
    process.stdout.write(
      `  simple-loop area=${area.toFixed(2)} m² (ideal ${SIMPLE_LOOP_AREA_M2} m², delta=${delta.toFixed(3)}%)\n`
    );

    expect(delta, "delta must be > 0 — noise/rotation must be applied").toBeGreaterThan(0);
    expect(delta).toBeLessThan(3);
  });
});

// ── AC5: MULTIPOLYGON validity ────────────────────────────────────────────────

describe("polygonizeTrack — AC5: multiPolygonWkt4326 validity (requires DB)", () => {
  dbIt("round-trips through ST_GeomFromText, SRID=4326, NumGeometries=faces.length", async () => {
    const track = generateSimpleLoop();
    const result = await polygonizeTrack(track);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrowing");

    const { pool } = await import("../db/pool.js");
    const check = await pool.query<{ is_valid: boolean; num_geoms: number; srid: number }>(
      `SELECT
         ST_IsValid(g)       AS is_valid,
         ST_NumGeometries(g) AS num_geoms,
         ST_SRID(g)          AS srid
       FROM (SELECT ST_GeomFromText($1, 4326) AS g) t`,
      [result.multiPolygonWkt4326]
    );

    const row = check.rows[0]!;
    process.stdout.write(
      `  multiPolygon: isValid=${String(row.is_valid)} numGeoms=${row.num_geoms} srid=${row.srid}\n`
    );
    expect(row.is_valid).toBe(true);
    expect(row.num_geoms).toBe(result.faces.length);
    expect(row.srid).toBe(4326);
  });
});

// ── AC6: determinism ──────────────────────────────────────────────────────────

describe("polygonizeTrack — AC6: determinism (requires DB)", () => {
  dbIt("same input twice returns deep-equal results", async () => {
    const track = generateFigureEight();
    const r1 = await polygonizeTrack(track);
    const r2 = await polygonizeTrack(track);
    expect(r1).toStrictEqual(r2);
  });
});

// ── AC7: noisy figure-eight produces microfaces ───────────────────────────────

describe("polygonizeTrack — AC7: noisy figure-eight microfaces (requires DB)", () => {
  dbIt(`produces MORE than ${NOISY_FIGURE_EIGHT_DOMINANT_FACES} faces; two largest dominate total area`, async () => {
    const track = generateNoisyFigureEight();
    const result = await polygonizeTrack(track);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrowing");

    process.stdout.write(`  noisy-figure-eight total faces: ${result.faces.length}\n`);
    result.faces.forEach((f, i) => {
      process.stdout.write(`    face[${i}]: area=${f.areaM2.toFixed(4)} m²\n`);
    });

    // Must produce MORE than 2 faces (microfaces at the crossing)
    expect(result.faces.length).toBeGreaterThan(NOISY_FIGURE_EIGHT_DOMINANT_FACES);

    // The two largest faces should account for the bulk of total area
    // (at least 80% — the microfaces are tiny)
    const top2 = result.faces.slice(0, 2).reduce((s, f) => s + f.areaM2, 0);
    const total = result.totalAreaM2;
    const dominancePct = top2 / total * 100;
    process.stdout.write(
      `  top-2 area=${top2.toFixed(2)} m² / total=${total.toFixed(2)} m² (${dominancePct.toFixed(1)}%)\n`
    );
    expect(dominancePct).toBeGreaterThan(80);
  });
});
