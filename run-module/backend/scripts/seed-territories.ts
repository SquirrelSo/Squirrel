/**
 * backend/scripts/seed-territories.ts
 *
 * DEV / TEST ONLY — never import this from production code.
 *
 * Inserts N synthetic territory rows (with parent runs) into the local
 * database, then runs ANALYZE so the query planner has accurate statistics
 * for the GIST index on territories.geom.
 *
 * ALL COORDINATES ARE SYNTHETIC — no real GPS data, no real user locations.
 *
 * Usage:
 *   npm run seed:dev                  # inserts 1000 territories (default)
 *   npm run seed:dev -- --count=5000  # inserts 5000 territories
 *
 * The script is idempotent in the sense that each run inserts fresh rows
 * (with new random UUIDs). Run it once before the EXPLAIN verification
 * in RM-3.1.
 */

import { Pool } from "pg";
import { randomUUID } from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Exiting.");
  process.exit(1);
}

const DEFAULT_COUNT = 1000;

// Parse optional --count=N argument
const countArg = process.argv.find((a) => a.startsWith("--count="));
const count = countArg
  ? Math.max(1, parseInt(countArg.split("=")[1] ?? "1000", 10))
  : DEFAULT_COUNT;

// Bounding box for synthetic territories (central London area, synthetic)
const BOX = {
  minLat:  51.45,
  maxLat:  51.55,
  minLng:  -0.20,
  maxLng:  -0.05,
};

// Polygon side size range in degrees (~50–200 m at this latitude)
const MIN_SIDE = 0.0005;
const MAX_SIDE = 0.0018;

// ── Helpers ───────────────────────────────────────────────────────────────────

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Build a WKT MultiPolygon string containing a single small rectangle.
 * Synthetic coordinates only.
 */
function syntheticMultiPolygonWKT(
  centLat: number,
  centLng: number,
  halfW: number,
  halfH: number
): string {
  const w = centLng - halfW;
  const e = centLng + halfW;
  const s = centLat - halfH;
  const n = centLat + halfH;
  // WKT ring must be closed (first == last), CCW for exterior
  return (
    `MULTIPOLYGON(((` +
    `${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}` +
    `)))`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: DATABASE_URL });

async function main(): Promise<void> {
  console.warn("⚠  seed-territories.ts is a DEV-ONLY script.");
  console.warn(`   Inserting ${count} synthetic territories into ${DATABASE_URL ?? ""}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fake owner ID — consistent across all seeded rows so index test queries
    // using this owner_id hit the partial index territories_owner_idx.
    const fakeOwnerId = "00000000-0000-0000-0000-000000000001";

    for (let i = 0; i < count; i++) {
      // Each territory needs a parent run row (FK: territories.run_id → runs.id)
      const runId = randomUUID();
      const userId = fakeOwnerId;

      await client.query(
        `INSERT INTO runs (id, user_id, started_at, status)
         VALUES ($1, $2, now(), 'finalized')`,
        [runId, userId]
      );

      // Synthetic territory
      const territoryId = randomUUID();
      const centLat = randBetween(BOX.minLat, BOX.maxLat);
      const centLng = randBetween(BOX.minLng, BOX.maxLng);
      const halfW = randBetween(MIN_SIDE, MAX_SIDE) / 2;
      const halfH = randBetween(MIN_SIDE, MAX_SIDE) / 2;
      const wkt = syntheticMultiPolygonWKT(centLat, centLng, halfW, halfH);

      // area_m2: approximate using the WGS84 degree-to-metre at this latitude
      // (synthetic estimate — good enough for seeding, not for production use)
      const areaM2 = (halfW * 2 * 111320 * Math.cos((centLat * Math.PI) / 180))
        * (halfH * 2 * 110574);

      await client.query(
        `INSERT INTO territories
           (id, owner_id, run_id, geom, area_m2, claimed_at, state)
         VALUES
           ($1, $2, $3, ST_GeomFromText($4, 4326), $5, now(), 'active')`,
        [territoryId, fakeOwnerId, runId, wkt, areaM2]
      );

      if ((i + 1) % 100 === 0) {
        process.stdout.write(`  inserted ${i + 1}/${count}\r`);
      }
    }

    await client.query("COMMIT");
    process.stdout.write(`  inserted ${count}/${count} — committed.\n`);

    // ANALYZE so the planner has fresh statistics for the GIST index
    console.warn("   Running ANALYZE territories...");
    await client.query("ANALYZE territories;");
    console.warn("   ANALYZE done.");

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("seed-territories failed:", err);
  process.exit(1);
});
