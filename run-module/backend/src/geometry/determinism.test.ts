/**
 * src/geometry/determinism.test.ts
 *
 * Full-pipeline determinism harness (RM-2.6).
 *
 * WHAT THIS TESTS
 *   Running processTrack twice on the SAME input point array must produce
 *   byte-identical WKT strings.  "Byte-identical" means === comparison on
 *   the serialized string — not deep-equal on parsed floats.
 *
 * WHY IT MATTERS
 *   RM-4.4 (statistical anti-cheat) detects a repeated run by comparing
 *   geometry.  If the pipeline is non-deterministic, that check produces
 *   silent false negatives.  This test is the signal that the guarantee holds.
 *
 * DATABASE BOUNDARY
 *   The test crosses the database boundary on every assertion.  ST_Node and
 *   ST_Polygonize (GEOS internals) and ST_Dump row ordering are where
 *   non-determinism would most plausibly originate.  A JavaScript-only
 *   comparison would prove nothing about those layers.
 *
 * NON-DETERMINISM RESPONSE
 *   If any fixture produces differing WKT strings, the test logs BOTH strings
 *   in full and fails immediately.  The correct response is to STOP and report
 *   the finding — do NOT fix it by rounding, sorting, or loosening the
 *   comparison.  The anti-cheat layer depends on this invariant.
 *
 * GOLDEN FILES
 *   On first run, WKT is written to __fixtures__/golden/<fixture>.wkt.
 *   On subsequent runs, the live output is compared against the golden.
 *   A mismatch means either a regression or an intentional pipeline change
 *   (see README.md in the golden/ directory for the regeneration procedure).
 *
 * FIXTURE SEED INDEPENDENCE
 *   Each fixture is regenerated from its seed before each pair of processTrack
 *   calls.  The two arrays are compared with deep-strict-equal to confirm
 *   that the seed produces the same input on both calls — proving the test
 *   isolates pipeline determinism from fixture determinism.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { processTrack } from "./pipeline.js";
import {
  generateSimpleLoop,
  generateFigureEight,
  generateNoisyFigureEight,
  generateOutAndBack,
} from "./__fixtures__/shape-tracks.js";
import type { LatLng } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLDEN_DIR = join(__dirname, "__fixtures__/golden");

// ── DB guard ──────────────────────────────────────────────────────────────────

const HAS_DB = typeof process.env["DATABASE_URL"] === "string" &&
  process.env["DATABASE_URL"].length > 0;

function dbIt(
  name: string,
  fn: () => Promise<void> | void
): ReturnType<typeof it> {
  return HAS_DB ? it(name, fn) : it.skip(`[no DATABASE_URL] ${name}`);
}

// ── Golden file helpers ───────────────────────────────────────────────────────

function goldenPath(fixtureName: string): string {
  return join(GOLDEN_DIR, `${fixtureName}.wkt`);
}

/**
 * Compare live WKT against the stored golden file, creating the golden on
 * first run.  Uses LF line endings and no trailing newline for stability.
 */
function checkGolden(fixtureName: string, liveWkt: string): void {
  const path = goldenPath(fixtureName);

  if (!existsSync(path)) {
    // First run: write the golden file with LF endings
    writeFileSync(path, liveWkt, { encoding: "utf8" });
    process.stdout.write(
      `  [GOLDEN CREATED] ${fixtureName}.wkt (${liveWkt.length} chars)\n`
    );
    return;
  }

  const stored = readFileSync(path, { encoding: "utf8" });
  // Normalise line endings in case git touched them on Windows
  const storedNorm = stored.replace(/\r\n/g, "\n");
  const liveNorm   = liveWkt.replace(/\r\n/g, "\n");

  if (storedNorm !== liveNorm) {
    process.stdout.write(
      `  [GOLDEN MISMATCH] ${fixtureName}.wkt\n` +
      `  stored (first 200): ${storedNorm.slice(0, 200)}\n` +
      `  live   (first 200): ${liveNorm.slice(0, 200)}\n`
    );
    expect(liveNorm, `Golden mismatch for ${fixtureName}`).toBe(storedNorm);
  } else {
    process.stdout.write(
      `  [GOLDEN OK] ${fixtureName}.wkt (${liveNorm.length} chars)\n`
    );
  }
}

// ── Fixture definitions ───────────────────────────────────────────────────────

interface FixtureSpec {
  name: string;
  generate: () => LatLng[];
  expectedOk: boolean;
}

const FIXTURES: FixtureSpec[] = [
  { name: "simple-loop",        generate: () => generateSimpleLoop(),        expectedOk: true  },
  { name: "figure-eight",       generate: () => generateFigureEight(),       expectedOk: true  },
  { name: "noisy-figure-eight", generate: () => generateNoisyFigureEight(),  expectedOk: true  },
  { name: "out-and-back",       generate: () => generateOutAndBack(),        expectedOk: true  },
];

// ── AC1+AC4: two-run identity for all four fixtures ───────────────────────────

describe("determinism — AC1: processTrack twice produces identical WKT (requires DB)", () => {
  for (const fixture of FIXTURES) {
    dbIt(`${fixture.name}: two runs produce === WKT strings`, async () => {
      // AC3: regenerate from seed to prove fixture stability
      const input1 = fixture.generate();
      const input2 = fixture.generate();
      expect(input1).toStrictEqual(input2);

      const r1 = await processTrack(input1);
      const r2 = await processTrack(input2);

      process.stdout.write(`  [${fixture.name}] ok1=${String(r1.ok)} ok2=${String(r2.ok)}\n`);

      if (fixture.expectedOk) {
        if (!r1.ok || !r2.ok) {
          process.stdout.write(
            `  UNEXPECTED FAILURE: r1.ok=${String(r1.ok)} r2.ok=${String(r2.ok)}\n`
          );
        }
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);

        if (!r1.ok || !r2.ok) return; // narrowing

        // Byte-identical WKT — the core assertion
        if (r1.multiPolygonWkt4326 !== r2.multiPolygonWkt4326) {
          process.stdout.write(
            `  NON-DETERMINISM DETECTED in ${fixture.name}!\n` +
            `  run1: ${r1.multiPolygonWkt4326.slice(0, 300)}\n` +
            `  run2: ${r2.multiPolygonWkt4326.slice(0, 300)}\n`
          );
        }
        expect(r1.multiPolygonWkt4326).toBe(r2.multiPolygonWkt4326);

        // Numeric fields must also be identical
        expect(r1.areaM2).toBe(r2.areaM2);
        expect(r1.perimeterM).toBe(r2.perimeterM);
        expect(r1.faceCount).toBe(r2.faceCount);

        process.stdout.write(
          `    area=${r1.areaM2.toFixed(2)} m² perim=${r1.perimeterM.toFixed(2)} m faces=${r1.faceCount}\n`
        );

        // AC4: golden file check
        checkGolden(fixture.name, r1.multiPolygonWkt4326);
      }
    });
  }
});

// ── AC2: noisy figure-eight — FIVE consecutive runs all identical ─────────────

describe("determinism — AC2: noisy figure-eight 5× identical (requires DB)", () => {
  dbIt("five processTrack runs produce identical WKT and faceCount", async () => {
    const input = generateNoisyFigureEight();
    const results: string[] = [];
    const faceCounts: number[] = [];

    for (let i = 0; i < 5; i++) {
      const r = await processTrack(generateNoisyFigureEight()); // fresh regeneration each time
      expect(r.ok, `run ${i} must succeed`).toBe(true);
      if (!r.ok) return;
      results.push(r.multiPolygonWkt4326);
      faceCounts.push(r.faceCount);
    }

    process.stdout.write(`  noisy-figure-eight ×5: faceCount=${faceCounts[0]!}\n`);
    process.stdout.write(`  WKT[0] (first 100): ${results[0]!.slice(0, 100)}\n`);

    // All five WKT strings must be === to each other
    for (let i = 1; i < 5; i++) {
      if (results[i] !== results[0]) {
        process.stdout.write(
          `  NON-DETERMINISM at run ${i}!\n` +
          `  run0: ${results[0]!.slice(0, 200)}\n` +
          `  run${i}: ${results[i]!.slice(0, 200)}\n`
        );
      }
      expect(results[i], `run ${i} WKT must === run 0 WKT`).toBe(results[0]);
      expect(faceCounts[i], `run ${i} faceCount must === run 0 faceCount`).toBe(faceCounts[0]);
    }

    // Also verify the fixture itself is deterministic (AC3)
    const inp2 = generateNoisyFigureEight();
    expect(inp2, "fixture regeneration must be deep-equal").toStrictEqual(input);

    process.stdout.write("  All 5 runs: byte-identical ✓\n");
  });
});

// ── AC5: 1-metre perturbation produces a DIFFERENT WKT ───────────────────────

describe("determinism — AC5: 1m perturbation sensitivity (requires DB)", () => {
  dbIt("perturbing one point by 1m produces a different WKT", async () => {
    const baseTrack = generateSimpleLoop();
    const perturbedTrack = baseTrack.map((p, i) =>
      // Perturb the second point by ~1 metre (≈ 0.000009° latitude)
      i === 1 ? { lat: p.lat + 0.000009, lng: p.lng } : p
    );

    const r1 = await processTrack(baseTrack);
    const r2 = await processTrack(perturbedTrack);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    process.stdout.write(
      `  base:      ${r1.multiPolygonWkt4326.slice(0, 80)}…\n` +
      `  perturbed: ${r2.multiPolygonWkt4326.slice(0, 80)}…\n`
    );

    // A 1m perturbation MUST produce a different WKT — if it doesn't, the
    // golden comparison is not sensitive and cannot detect regressions.
    expect(r1.multiPolygonWkt4326).not.toBe(r2.multiPolygonWkt4326);
    process.stdout.write("  Perturbation sensitivity confirmed: WKTs differ ✓\n");
  });
});
