/**
 * src/workers/finalize_run/__fixtures__/seed-run.ts
 *
 * Test helper to seed a raw run and its points into the database.
 * No user row is needed because the system operates on external identities.
 */

import { randomUUID } from "crypto";
import { pool } from "../../../db/pool.js";
import type { LatLng } from "../../../geometry/types.js";

export async function seedRun(
  points: readonly LatLng[],
  userIdOverride?: string,
  options?: { elapsedTimeS?: number | null }
): Promise<{ runId: string; userId: string }> {
  const runId = randomUUID();
  const userId = userIdOverride ?? randomUUID();
  const startedAt = new Date();
  const elapsedTimeS = options && options.elapsedTimeS !== undefined ? options.elapsedTimeS : 60;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Seed the run
    await client.query(
      `
      INSERT INTO runs (
        id, user_id, started_at, status, distance_m, moving_time_s, elapsed_time_s
      )
      VALUES ($1, $2, $3, 'finishing', 100, $4, $5)
    `,
      [runId, userId, startedAt, elapsedTimeS, elapsedTimeS]
    );

    // Seed the points
    if (points.length > 0) {
      // Build a VALUES list for bulk insert
      const values = [];
      const params = [];
      let paramIdx = 1;
      
      let currentTime = startedAt.getTime();
      let prevPt = points[0];
      if (!prevPt) throw new Error("Empty points array");

      // We need distance function. Let's just approximate if we can't import it easily.
      // 1 degree lat = 111320m. 1 degree lng = 111320 * cos(lat)
      function approxDist(p1: LatLng, p2: LatLng) {
         const dLat = (p2.lat - p1.lat) * 111320;
         const dLng = (p2.lng - p1.lng) * 111320 * Math.cos(p1.lat * Math.PI / 180);
         return Math.sqrt(dLat*dLat + dLng*dLng);
      }

      for (let i = 0; i < points.length; i++) {
        const pt = points[i]!;
        if (i > 0) {
           const d = approxDist(prevPt, pt);
           const dtMs = Math.max(1000, (d / 3.0) * 1000); // 3 m/s
           currentTime += dtMs;
        }
        prevPt = pt;
        
        values.push(
          `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, to_timestamp($${paramIdx++}))`
        );
        params.push(runId, i, pt.lat, pt.lng, currentTime / 1000);
      }

      const sql = `
        INSERT INTO run_points (run_id, seq, lat, lng, recorded_at)
        VALUES ${values.join(", ")}
      `;

      await client.query(sql, params);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { runId, userId };
}
