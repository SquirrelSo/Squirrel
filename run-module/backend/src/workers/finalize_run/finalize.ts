import { captureTerritory } from './capture.js';
import { enqueueLeaderboardSync } from '../leaderboard_sync/queue.js';
import { enqueueNotificationSync } from '../../notifications/emitter.js';
import { publishRun } from '../../social/publish.js';
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { pool } from "../../db/pool.js";
import { processTrack, type PipelineResult } from "../../geometry/pipeline.js";
import { scoreRun } from "../../anticheat/aggregate.js";
import type { LatLng } from "../../geometry/types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type FinalizeResult =
  | {
      ok: true;
      territoryId: string | null;
      areaM2: number;
      faceCount: number;
      repaired: boolean; attempts?: number;
    }
  | {
      ok: false;
      reason: string;
      detail: string;
    };

// ── SQL queries ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const queriesSql = readFileSync(
  join(__dirname, "../../../../db/queries/finalize-run.sql"),
  "utf8"
);

// Split by the sentinel comment. The first segment is the file header, so we drop it.
const fragments = queriesSql
  .split(/^----$/m)
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .slice(1);

const SELECT_RUN_FOR_UPDATE = fragments[0]!;
const SELECT_POINTS = fragments[1]!;
const UPDATE_STATUS = fragments[2]!;
const INSERT_REJECTION = fragments[3]!;
const INSERT_TERRITORY = fragments[4]!;
const CHECK_TERRITORY_AREA = fragments[5]!;
const INSERT_ACTIVITY_SESSION = fragments[6]!;

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeIntensity(
  distanceM: number | null,
  durationS: number | null
): "low" | "moderate" | "vigorous" | null {
  if (!distanceM || !durationS || durationS <= 0) return null;
  const speed = distanceM / durationS;
  if (speed < 1.34) return "low";
  if (speed <= 2.68) return "moderate";
  return "vigorous";
}

// ── Main logic ────────────────────────────────────────────────────────────────

export async function finalizeRun(runId: string): Promise<FinalizeResult> {
  let attempts = 0;
  while (attempts < 5) {
    attempts++;
    const client = await pool.connect();
    try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

    // 1. Lock the run and read status + owner
    const runRes = await client.query<{
      user_id: string;
      status: string;
      started_at: Date;
      distance_m: number | null;
      elapsed_time_s: number | null;
      timezone: string | null;
    }>(SELECT_RUN_FOR_UPDATE, [runId]);

    if (runRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "run_not_found",
        detail: `Run ${runId} does not exist`,
      };
    }

    const run = runRes.rows[0]!;

    // Idempotency check
    if (run.status === "finalized" || run.status === "rejected" || run.status === "flagged") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "already_finalized",
        detail: `Run ${runId} is already ${run.status}`,
      };
    }

    // 2. Load points
    const pointsRes = await client.query<{ lat: number; lng: number; recorded_at: Date }>(
      SELECT_POINTS,
      [runId]
    );

    const activityStartedAt = pointsRes.rows.reduce<Date | null>((earliest, point) => {
      if (!earliest || point.recorded_at < earliest) return point.recorded_at;
      return earliest;
    }, null) ?? new Date();

    const points: LatLng[] = pointsRes.rows.map((r) => ({ lat: r.lat, lng: r.lng }));

    // 3. Compute duration for the activity session
    let durationS = run.elapsed_time_s;
    if (durationS === null && pointsRes.rows.length > 0) {
      const first = pointsRes.rows[0]!.recorded_at.getTime();
      const last = pointsRes.rows[pointsRes.rows.length - 1]!.recorded_at.getTime();
      durationS = Math.max(0, Math.floor((last - first) / 1000));
    } else if (durationS === null) {
      durationS = 0;
    }

    const intensity = computeIntensity(run.distance_m, durationS);


        
    let trackDistanceM = 0;
    let autoPauseTimeS = 0;
    let currentPauseDuration = 0;
    
    for (let i = 1; i < pointsRes.rows.length; i++) {
      const p1 = pointsRes.rows[i-1]!;
      const p2 = pointsRes.rows[i]!;
      const dt = (p2.recorded_at.getTime() - p1.recorded_at.getTime()) / 1000;
      
      const dLat = (p2.lat - p1.lat) * Math.PI / 180;
      const dLng = (p2.lng - p1.lng) * Math.PI / 180;
      const latMid = (p1.lat + p2.lat) / 2 * Math.PI / 180;
      const dx = dLng * Math.cos(latMid);
      const dy = dLat;
      const dist = 6371000 * Math.sqrt(dx * dx + dy * dy);
      trackDistanceM += dist;
      
      if (dt > 0) {
        const speed = dist / dt;
        if (speed < 0.5) {
          currentPauseDuration += dt;
        } else {
          if (currentPauseDuration > 10) {
            autoPauseTimeS += currentPauseDuration;
          }
          currentPauseDuration = 0;
        }
      }
    }
    if (currentPauseDuration > 10) {
      autoPauseTimeS += currentPauseDuration;
    }
    
    const movingTimeS = Math.max(0, durationS - Math.floor(autoPauseTimeS));
    let meanSpeedMs: number | null = null;
    if (durationS > 0) {
      meanSpeedMs = trackDistanceM / durationS;
    }
    
    await client.query(
      'UPDATE runs SET distance_m = $1, moving_time_s = $2, elapsed_time_s = $3 WHERE id = $4',
      [trackDistanceM, movingTimeS, durationS, runId]
    );

    const hashStr = points.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');
    const pointHash = crypto.createHash('sha256').update(hashStr).digest('hex');

    // Helper for rejection path to ensure activity session is written

    const rejectRun = async (reason: string, detail: string, band?: string, wkt?: string, areaM2?: number): Promise<FinalizeResult> => {
      await client.query(UPDATE_STATUS, ["rejected", runId]);
      await client.query(INSERT_REJECTION, [runId, reason, detail]);
      
      const metrics: any = {
        distance_m: trackDistanceM,
        area_m2: 0,
        moving_time_s: movingTimeS,
        elapsed_time_s: durationS,
        territory_claimed: false,
        rejection_reason: reason,
        ...(run.timezone ? { timezone: run.timezone } : {}),
      };
      if (band) metrics.band = band;

      await client.query(INSERT_ACTIVITY_SESSION, [
        crypto.randomUUID(),
        run.user_id,
        activityStartedAt,
        durationS,
        intensity,
        JSON.stringify(metrics),
      ]);

      if (wkt && areaM2 !== undefined) {
        await client.query(
          "INSERT INTO run_signatures (run_id, user_id, point_hash, geom_centroid, area_m2, duration_s, mean_speed_ms) VALUES ($1, $2, $3, ST_Centroid(ST_GeomFromText($4, 4326)), $5, $6, $7) ON CONFLICT (run_id) DO NOTHING",
          [runId, run.user_id, pointHash, wkt, areaM2, durationS || null, meanSpeedMs]
        );
      } else {
        await client.query(
          "INSERT INTO run_signatures (run_id, user_id, point_hash, geom_centroid, area_m2, duration_s, mean_speed_ms) VALUES ($1, $2, $3, NULL, NULL, $4, $5) ON CONFLICT (run_id) DO NOTHING",
          [runId, run.user_id, pointHash, durationS || null, meanSpeedMs]
        );
      }
      await client.query("COMMIT");

      return { ok: false as const, reason, detail };
    };

    if (pointsRes.rows.length < 4) {
      return await rejectRun(
        "insufficient_points",
        `Run has ${pointsRes.rows.length} points (minimum 4 required)`
      );
    }

    // 4. Process track through pipeline
    const pipelineResult: PipelineResult = await processTrack(points);

    if (!pipelineResult.ok) {
      const noTerritoryReasons = new Set(["not_closed", "no_faces", "below_minimum_area"]);
      if (!noTerritoryReasons.has(pipelineResult.reason)) {
        return await rejectRun(pipelineResult.reason, pipelineResult.detail);
      }

      // A route can be a valid activity without enclosing a territory. Keep
      // the reason separate from rejection_reason so XP and app status remain
      // activity-level, and still run the existing anti-cheat layers.
      await client.query(
        "INSERT INTO run_signatures (run_id, user_id, point_hash, geom_centroid, area_m2, duration_s, mean_speed_ms) VALUES ($1, $2, $3, NULL, NULL, $4, $5) ON CONFLICT (run_id) DO NOTHING",
        [runId, run.user_id, pointHash, durationS || null, meanSpeedMs]
      );
      const scoreRes = await scoreRun(runId, undefined, {
        user_id: run.user_id,
        point_hash: pointHash,
        area_m2: null,
        duration_s: durationS || null,
        mean_speed_ms: meanSpeedMs,
      });
      await client.query(`
        INSERT INTO run_scores (run_id, aggregate, band, layers, scored_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (run_id) DO UPDATE
        SET aggregate = EXCLUDED.aggregate, band = EXCLUDED.band, layers = EXCLUDED.layers, scored_at = EXCLUDED.scored_at
      `, [runId, scoreRes.aggregate, scoreRes.band, JSON.stringify(scoreRes.layers)]);

      if (scoreRes.band === "reject") {
        return await rejectRun(
          "anticheat_rejected",
          `Decisive layer: ${scoreRes.decisiveLayer || "aggregate"}, Score: ${scoreRes.aggregate}`,
          scoreRes.band
        );
      }

      const finalStatus = scoreRes.band === "pending" ? "flagged" : "finalized";
      await client.query("UPDATE runs SET status = $1, territory_reason = $2 WHERE id = $3", [finalStatus, pipelineResult.reason, runId]);
      await client.query(INSERT_ACTIVITY_SESSION, [
        crypto.randomUUID(), run.user_id, activityStartedAt, durationS, intensity,
        JSON.stringify({
          distance_m: trackDistanceM,
          area_m2: 0,
          moving_time_s: movingTimeS,
          elapsed_time_s: durationS,
          territory_claimed: false,
          territory_reason: pipelineResult.reason,
          rejection_reason: null,
          band: scoreRes.band,
          ...(run.timezone ? { timezone: run.timezone } : {}),
        }),
      ]);
      await client.query("COMMIT");

      try {
        await enqueueLeaderboardSync([]);
        await enqueueNotificationSync(runId, []);
      } catch (err) {
        console.error("Failed to enqueue leaderboard sync:", err);
      }
      if (finalStatus === "finalized") {
        void publishRun({ runId, userId: run.user_id, startedAt: run.started_at, distanceM: trackDistanceM, movingTimeS, elapsedTimeS: durationS, areaM2: 0 });
      }
      return { ok: true, territoryId: null, areaM2: 0, faceCount: 0, repaired: false };
    }

    // We insert signature BEFORE anti-cheat scoring so it can catch replays even if rejected
    await client.query(
      "INSERT INTO run_signatures (run_id, user_id, point_hash, geom_centroid, area_m2, duration_s, mean_speed_ms) VALUES ($1, $2, $3, ST_Centroid(ST_GeomFromText($4, 4326)), $5, $6, $7) ON CONFLICT (run_id) DO NOTHING",
      [runId, run.user_id, pointHash, pipelineResult.multiPolygonWkt4326, pipelineResult.areaM2, durationS || null, meanSpeedMs]
    );

    // 5. Anti-cheat scoring (RM-4.6)
    // We must score BEFORE territory insert to block reject.
    const scoreRes = await scoreRun(runId, pipelineResult.multiPolygonWkt4326, {
      user_id: run.user_id,
      point_hash: pointHash,
      area_m2: pipelineResult.areaM2,
      duration_s: durationS || null,
      mean_speed_ms: meanSpeedMs
    });
    
    await client.query(`
      INSERT INTO run_scores (run_id, aggregate, band, layers, scored_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (run_id) DO UPDATE 
      SET aggregate = EXCLUDED.aggregate, band = EXCLUDED.band, layers = EXCLUDED.layers, scored_at = EXCLUDED.scored_at
    `, [runId, scoreRes.aggregate, scoreRes.band, JSON.stringify(scoreRes.layers)]);

    if (scoreRes.band === 'reject') {
      return await rejectRun(
        "anticheat_rejected",
        `Decisive layer: ${scoreRes.decisiveLayer || 'aggregate'}, Score: ${scoreRes.aggregate}`,
        scoreRes.band
        // We no longer need to pass WKT to rejectRun because it's already inserted above!
      );
    }

    // 5. Insert territory with a savepoint for the consistency guard
    await client.query("SAVEPOINT before_territory");
    

    
    const captureRes = await captureTerritory({
      client,
      runId,
      ownerId: run.user_id,
      geomWkt4326: pipelineResult.multiPolygonWkt4326,
      areaM2: pipelineResult.areaM2,
      attempts
    });


    // 6. Consistency Guard
    const chkRes = await client.query<{
      recomputed_area: number;
      is_empty: boolean;
      num_geoms: number;
    }>(CHECK_TERRITORY_AREA, [captureRes.territoryId]);
    
    const chk = chkRes.rows[0]!;
    
    if (chk.is_empty || chk.num_geoms === 0) {
      await client.query("ROLLBACK TO SAVEPOINT before_territory");
      return await rejectRun("area_geometry_mismatch", "Stored geometry is empty");
    }

    const delta = Math.abs(chk.recomputed_area - pipelineResult.areaM2) / pipelineResult.areaM2;
    if (delta > 0.005) {
      await client.query("ROLLBACK TO SAVEPOINT before_territory");
      return await rejectRun(
        "area_geometry_mismatch",
        `Stored area ${pipelineResult.areaM2} differs from geometry area ${chk.recomputed_area}`
      );
    }

    // 7. Update run status and insert activity session for success
    const finalStatus = scoreRes.band === 'pending' ? 'flagged' : 'finalized';
    await client.query(UPDATE_STATUS, [finalStatus, runId]);
    
    await client.query(INSERT_ACTIVITY_SESSION, [
      crypto.randomUUID(),
      run.user_id,
      activityStartedAt,
      durationS,
      intensity,
      JSON.stringify({
        distance_m: trackDistanceM,
        area_m2: pipelineResult.areaM2,
        moving_time_s: movingTimeS,
        elapsed_time_s: durationS,
        territory_claimed: true,
        rejection_reason: null,
        band: scoreRes.band,
        ...(run.timezone ? { timezone: run.timezone } : {}),
      }),
    ]);


    await client.query(
      "INSERT INTO run_signatures (run_id, user_id, point_hash, geom_centroid, area_m2, duration_s, mean_speed_ms) VALUES ($1, $2, $3, ST_Centroid(ST_GeomFromText($4, 4326)), $5, $6, $7) ON CONFLICT (run_id) DO NOTHING",
      [runId, run.user_id, pointHash, pipelineResult.multiPolygonWkt4326, pipelineResult.areaM2, durationS || null, meanSpeedMs]
    );

    // All done
    await client.query("COMMIT");

    try {
      await enqueueLeaderboardSync(captureRes.emittedEventIds);
      await enqueueNotificationSync(runId, captureRes.emittedEventIds);
    } catch (err) {
      console.error('Failed to enqueue leaderboard sync:', err);
    }

    // To the runner's Social profile: background, never throws. Flagged runs wait for review.
    if (finalStatus === 'finalized') {
      void publishRun({
        runId,
        userId: run.user_id,
        startedAt: run.started_at,
        distanceM: trackDistanceM,
        movingTimeS,
        elapsedTimeS: durationS,
        areaM2: pipelineResult.areaM2,
      });
    }

    return {
      ok: true,
      territoryId: captureRes.territoryId, attempts: captureRes.attempts,
      areaM2: pipelineResult.areaM2,
      faceCount: pipelineResult.faceCount,
      repaired: pipelineResult.repaired,
    };
  } catch (error: any) {
      await client.query("ROLLBACK");
      if (error.code === '40001' || error.code === '40P01') {
        if (attempts >= 5) throw error;
        const backoff = 20 * Math.pow(2, attempts - 1) + Math.random() * 10;
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error('unreachable');
}
