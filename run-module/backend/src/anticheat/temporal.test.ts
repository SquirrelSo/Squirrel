import {  describe, it, expect , afterEach } from 'vitest';
import { pool } from "../db/pool.js";
import { scoreTemporal } from "./temporal.js";
import { finalizeRun } from "../workers/finalize_run/finalize.js";
import {
  generateOverlappingRunPair,
  generateAdjacentRunPair,
  generateOfflineUploadRun,
  generateImpossibleUploadRun,
  TrackPoint
} from "./__fixtures__/motion-tracks.js";
import crypto from "crypto";
export const testRunIds: string[] = [];
export const testUserIds: string[] = [];

async function seedRunTemporal(userId: string, points: TrackPoint[], hasBatches = true): Promise<string> {
  const runId = crypto.randomUUID(); testRunIds.push(runId);
  await pool.query(
    "INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'active', now())",
    [runId, userId]
  );
  
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    await pool.query(
      `INSERT INTO run_points (run_id, seq, lat, lng, recorded_at) VALUES ($1, $2, $3, $4, $5)`,
      [runId, i, p.lat, p.lng, p.recorded_at]
    );
  }

  if (hasBatches) {
    await pool.query(
      `INSERT INTO run_batches (id, run_id, point_count, first_seq, last_seq, uploaded_at) VALUES ($1, $2, $3, $4, $5, now())`,
      [crypto.randomUUID(), runId, points.length, 0, points.length - 1]
    );
  }

  await pool.query("UPDATE runs SET status = 'finishing' WHERE id = $1", [runId]);
  await finalizeRun(runId);
  return runId;
}

describe("Temporal Scoring Layer", () => {

  afterEach(async () => {
    if (testRunIds.length > 0) {
      const ids = [...testRunIds];
      const uids = testUserIds.length > 0 ? [...testUserIds] : ['00000000-0000-0000-0000-000000000000'];
      await pool.query("DELETE FROM capture_events WHERE territory_id IN (SELECT id FROM territories WHERE run_id = ANY($1)) OR actor_id = ANY($2)", [ids, uids]);
      await pool.query("DELETE FROM territories WHERE run_id = ANY($1) OR owner_id = ANY($2)", [ids, uids]);
      await pool.query("DELETE FROM run_scores WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_signatures WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_rejections WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_point_flags WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_batches WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_points WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM runs WHERE id = ANY($1)", [ids]);
      testRunIds.length = 0;
    }
  });

  it("AC1: two runs by the same user with overlapping point windows are BOTH flagged", async () => {
    const userId = crypto.randomUUID();
    const [t1, t2] = generateOverlappingRunPair();
    const run1 = await seedRunTemporal(userId, t1); testRunIds.push(run1);
    // wait a moment so created_at ordering is clear
    await new Promise(r => setTimeout(r, 50)); 
    const run2 = await seedRunTemporal(userId, t2); testRunIds.push(run2);

    const res1 = await scoreTemporal(run1);
    const res2 = await scoreTemporal(run2);

    expect(res1.signals.overlapping_run_ids).toContain(run2);
    expect(res2.signals.overlapping_run_ids).toContain(run1);
    expect(res1.score).toBe(0.6);
    expect(res2.score).toBe(0.6);
    expect(res1.signals.max_overlap_seconds).toBeGreaterThan(60);
    expect(res2.signals.max_overlap_seconds).toBeGreaterThan(60);
  });

  it("AC2: generateAdjacentRunPair produces empty overlapping_run_ids for both and both score 1.0", async () => {
    const userId = crypto.randomUUID();
    const [t1, t2] = generateAdjacentRunPair();
    const run1 = await seedRunTemporal(userId, t1); testRunIds.push(run1);
    await new Promise(r => setTimeout(r, 50)); 
    const run2 = await seedRunTemporal(userId, t2); testRunIds.push(run2);

    const res1 = await scoreTemporal(run1);
    const res2 = await scoreTemporal(run2);

    expect(res1.signals.overlapping_run_ids).toHaveLength(0);
    expect(res2.signals.overlapping_run_ids).toHaveLength(0);
    expect(res1.score).toBe(1.0);
    expect(res2.score).toBe(1.0);
  });

  it("AC3: generateOfflineUploadRun scores 1.0 with a large POSITIVE upload_skew_s", async () => {
    const userId = crypto.randomUUID();
    const t = generateOfflineUploadRun();
    const run = await seedRunTemporal(userId, t); testRunIds.push(run);

    const res = await scoreTemporal(run);
    expect(res.score).toBe(1.0);
    expect(res.signals.upload_skew_s).toBeGreaterThan(3600); // at least 1 hr skew
    expect(res.signals.impossible_upload).toBe(false);
  });

  it("AC4: generateImpossibleUploadRun scores 0.0 with impossible_upload true and a negative upload_skew_s", async () => {
    const userId = crypto.randomUUID();
    const t = generateImpossibleUploadRun();
    const run = await seedRunTemporal(userId, t); testRunIds.push(run);

    const res = await scoreTemporal(run);
    expect(res.score).toBe(0.0);
    expect(res.signals.impossible_upload).toBe(true);
    expect(res.signals.upload_skew_s).toBeLessThan(-3600); // -2 hours
  });

  it("AC5: Overlapping runs by DIFFERENT users are not flagged", async () => {
    const user1 = crypto.randomUUID();
    const user2 = crypto.randomUUID();
    const [t1, t2] = generateOverlappingRunPair();
    const run1 = await seedRunTemporal(user1, t1); testRunIds.push(run1);
    const run2 = await seedRunTemporal(user2, t2); testRunIds.push(run2);

    const res1 = await scoreTemporal(run1);
    const res2 = await scoreTemporal(run2);

    expect(res1.signals.overlapping_run_ids).toHaveLength(0);
    expect(res2.signals.overlapping_run_ids).toHaveLength(0);
  });

  it("AC6: A run with no run_batches rows reports batch_count 0, upload_skew_s null, and scores 1.0", async () => {
    const userId = crypto.randomUUID();
    const [t1] = generateOverlappingRunPair();
    const run = await seedRunTemporal(userId, t1, false); testRunIds.push(run);

    const res = await scoreTemporal(run);
    expect(res.score).toBe(1.0);
    expect(res.signals.batch_count).toBe(0);
    expect(res.signals.upload_skew_s).toBeNull();
  });

  it("AC7: An overlap of under OVERLAP_MIN_SECONDS is not flagged", async () => {
    const userId = crypto.randomUUID();
    const baseTrack = generateOfflineUploadRun();
    const t1 = [];
    const t2 = [];
    const baseTime = Date.now() - 3600 * 1000;
    // Overlap of 30 seconds
    for(let i=0; i<100; i++) {
      t1.push({ ...baseTrack[0], recorded_at: new Date(baseTime + i * 1000) });
    }
    // t1 ends at baseTime + 99s. t2 starts at baseTime + 69s (overlap = 30s)
    for(let i=0; i<100; i++) {
      t2.push({ ...baseTrack[0], recorded_at: new Date(baseTime + 69000 + i * 1000) });
    }

    await seedRunTemporal(userId, t1 as TrackPoint[]);
    const run2 = await seedRunTemporal(userId, t2 as TrackPoint[]); testRunIds.push(run2);

    const res = await scoreTemporal(run2);
    // overlap of 30 seconds should NOT be flagged
    expect(res.signals.max_overlap_seconds).toBeCloseTo(30, 0);
    expect(res.signals.overlapping_run_ids).toHaveLength(0);
  });

  it("AC8: compared_against caps at TEMPORAL_LOOKBACK_RUNS", async () => {
    const userId = crypto.randomUUID();
    for (let i = 0; i < 51; i++) {
      const [t1] = generateAdjacentRunPair(); // arbitrary points
      await seedRunTemporal(userId, t1, false);
    }
    const [tLast] = generateAdjacentRunPair();
    const runLast = await seedRunTemporal(userId, tLast, false); testRunIds.push(runLast);

    const res = await scoreTemporal(runLast);
    expect(res.signals.compared_against).toBe(50);
  }, 30000);

  it("AC9: Determinism, writes-nothing, and [0,1] clamping", async () => {
    const userId = crypto.randomUUID();
    const [t1] = generateOverlappingRunPair();
    const run = await seedRunTemporal(userId, t1); testRunIds.push(run);
    
    const preScoreStats = await pool.query("SELECT count(*) FROM runs");
    
    const r1 = await scoreTemporal(run);
    const r2 = await scoreTemporal(run);

    const postScoreStats = await pool.query("SELECT count(*) FROM runs");

    expect(r1).toEqual(r2);
    expect(preScoreStats.rows[0].count).toBe(postScoreStats.rows[0].count);
    expect(r1.score).toBeGreaterThanOrEqual(0);
    expect(r1.score).toBeLessThanOrEqual(1);
  });
});
