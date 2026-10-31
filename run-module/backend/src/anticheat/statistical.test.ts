import {  describe, it, expect , afterEach } from 'vitest';
import { pool } from "../db/pool.js";
import { scoreStatistical } from "./statistical.js";
import { finalizeRun } from "../workers/finalize_run/finalize.js";
import {
  generateRealisticPaceTrack,
  generateConstantSpeedTrack,
  generateReplayTrack,
  generateJitteredReplayTrack,
  generateSlowerReplayTrack,
  TrackPoint
} from "./__fixtures__/motion-tracks.js";
import crypto from "crypto";
export const testRunIds: string[] = [];
export const testUserIds: string[] = [];

async function seedRunStatistical(userId: string, points: TrackPoint[], finalize = true): Promise<string> {
  const runId = crypto.randomUUID(); testRunIds.push(runId);
  await pool.query(
    "INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'active', now())",
    [runId, userId]
  );
  
  const values: any[] = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    await pool.query(
      `INSERT INTO run_points (run_id, seq, lat, lng, recorded_at) VALUES ($1, $2, $3, $4, $5)`,
      [runId, i, p.lat, p.lng, p.recorded_at ?? new Date(baseTime + i * 1000)]
    );
  }

  await pool.query(
    `INSERT INTO run_batches (id, run_id, point_count, first_seq, last_seq) VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), runId, points.length, 0, points.length - 1]
  );

  await pool.query(
    "UPDATE runs SET status = 'finishing' WHERE id = $1",
    [runId]
  );

  if (finalize) {
    const res = await finalizeRun(runId);
  }

  return runId;
}

describe("Statistical Scoring Layer", () => {

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

  it("AC1 & New Fix: constant-speed and realistic-pace share geometry but different pace -> near_dup is NULL, same_route_different_pace is populated", async () => {
    const user = crypto.randomUUID();
    const runIdBase = await seedRunStatistical(user, generateRealisticPaceTrack(101)); testRunIds.push(runIdBase);
    const baseConstant = generateConstantSpeedTrack(101);
    const track = baseConstant.map(pt => ({ ...pt, lat: pt.lat + 0.00001 })); 
    const runIdSameRoute = await seedRunStatistical(user, track);  testRunIds.push(runIdSameRoute);
    const res = await scoreStatistical(runIdSameRoute);
    
    // Should score below 0.5 due to speed_cv alone, not duplicate
    expect(res.score).toBeLessThan(0.5);
    expect(res.signals.speed_cv).toBeLessThan(0.05);
    
    // Near duplicate should be NULL, but same_route_different_pace should be populated
    expect(res.signals.near_duplicate_run_id).toBeNull();
    expect(res.signals.same_route_different_pace_run_id).toBe(runIdBase);
  });

  it("AC2: a run uploaded twice by the SAME user is flagged with exact_duplicate_run_id", async () => {
    const userId = crypto.randomUUID();
    const track = generateRealisticPaceTrack();
    const runId1 = await seedRunStatistical(userId, track); testRunIds.push(runId1);
    
    const replayTrack = generateReplayTrack(track);
    // wait a moment so created_at ordering is clear
    await new Promise(r => setTimeout(r, 100)); 
    const runId2 = await seedRunStatistical(userId, replayTrack); testRunIds.push(runId2);

    const res = await scoreStatistical(runId2);
    expect(res.score).toBe(0.0);
    expect(res.signals.exact_duplicate_run_id).toBe(runId1);
  });

  it("AC3: generateRealisticPaceTrack scores ABOVE 0.5 and has CV >= 0.10", async () => {
    const userId = crypto.randomUUID();
    const track = generateRealisticPaceTrack();
    const runId = await seedRunStatistical(userId, track); testRunIds.push(runId);
    
    const res = await scoreStatistical(runId);
    expect(res.score).toBeGreaterThan(0.5);
    expect(res.signals.speed_cv).toBeGreaterThanOrEqual(0.10);
  });

  it("AC4: generateJitteredReplayTrack has NULL exact but non-null near duplicate, scores 0.3", async () => {
    const userId = crypto.randomUUID();
    const track = generateRealisticPaceTrack();
    const runId1 = await seedRunStatistical(userId, track); testRunIds.push(runId1);
    
    const jittered = generateJitteredReplayTrack(track);
    const runId2 = await seedRunStatistical(userId, jittered); testRunIds.push(runId2);

    const res = await scoreStatistical(runId2);
    expect(res.score).toBe(0.3);
    expect(res.signals.exact_duplicate_run_id).toBeNull();
    expect(res.signals.near_duplicate_run_id).toBe(runId1);
  });

  it("AC10: generateSlowerReplayTrack - same route, 40% slower -> near_dup is NULL, scores above 0.5", async () => {
    const userId = crypto.randomUUID();
    const track = generateRealisticPaceTrack();
    const runId1 = await seedRunStatistical(userId, track); testRunIds.push(runId1);
    
    const slower = generateSlowerReplayTrack(track);
    const runId2 = await seedRunStatistical(userId, slower); testRunIds.push(runId2);

    const res = await scoreStatistical(runId2);
    expect(res.score).toBeGreaterThan(0.5);
    expect(res.signals.near_duplicate_run_id).toBeNull();
    expect(res.signals.same_route_different_pace_run_id).toBe(runId1);
  });

  it("AC11: prior signature with NULL duration_s does not produce a near-duplicate match", async () => {
    const userId = crypto.randomUUID();
    const track = generateRealisticPaceTrack();
    const runId1 = await seedRunStatistical(userId, track); testRunIds.push(runId1);
    
    // Simulate pre-migration signature by setting duration_s to NULL
    await pool.query("UPDATE run_signatures SET duration_s = NULL WHERE run_id = $1", [runId1]);
    
    const jittered = generateJitteredReplayTrack(track);
    const runId2 = await seedRunStatistical(userId, jittered); testRunIds.push(runId2);

    const res = await scoreStatistical(runId2);
    // Because the old signature has NULL duration, it shouldn't match as near-duplicate or same-route-different-pace
    expect(res.signals.near_duplicate_run_id).toBeNull();
    expect(res.signals.same_route_different_pace_run_id).toBeNull();
  });

  it("AC5: The SAME track uploaded by a DIFFERENT user is NOT flagged", async () => {
    const userId1 = crypto.randomUUID();
    const userId2 = crypto.randomUUID();
    const track = generateRealisticPaceTrack();
    
    const runId1 = await seedRunStatistical(userId1, track); testRunIds.push(runId1);
    const runId2 = await seedRunStatistical(userId2, track); testRunIds.push(runId2);

    const res = await scoreStatistical(runId2);
    expect(res.score).toBeGreaterThan(0.5);
    expect(res.signals.exact_duplicate_run_id).toBeNull();
    expect(res.signals.near_duplicate_run_id).toBeNull();
  });

  it("AC6: run_signatures gets exactly one row per finalized run, including rejected runs", async () => {
    const userId = crypto.randomUUID();
    const track = generateRealisticPaceTrack();
    // Valid run
    const runId1 = await seedRunStatistical(userId, track); testRunIds.push(runId1);
    const res1 = await pool.query("SELECT * FROM run_signatures WHERE run_id = $1", [runId1]);
    expect(res1.rowCount).toBe(1);
    expect(res1.rows[0].area_m2).not.toBeNull();

    // Rejected run (e.g., only 3 points)
    const runId2 = await seedRunStatistical(userId, track.slice(0, 3)); testRunIds.push(runId2);
    const res2 = await pool.query("SELECT * FROM run_signatures WHERE run_id = $1", [runId2]);
    expect(res2.rowCount).toBe(1);
    expect(res2.rows[0].area_m2).toBeNull(); // Rejected -> no territory -> NULL
  });

  it("AC7 & AC8: compared_against never exceeds 50; first run has compared_against 0", async () => {
    const userId = crypto.randomUUID();
    // First run
    const runId1 = await seedRunStatistical(userId, generateRealisticPaceTrack()); testRunIds.push(runId1);
    const res1 = await scoreStatistical(runId1);
    expect(res1.signals.compared_against).toBe(0);

    // Seed 51 more runs
    for (let i = 0; i < 51; i++) {
      const p = generateRealisticPaceTrack().map(pt => ({ ...pt, lat: pt.lat + (i * 0.0001) })); // slightly shifted so not duplicate
      await seedRunStatistical(userId, p);
    }
    
    // Test the 53rd run
    const runIdLast = await seedRunStatistical(userId, generateRealisticPaceTrack()); testRunIds.push(runIdLast);
    const resLast = await scoreStatistical(runIdLast);
    const { rows: sigs } = await pool.query("SELECT count(*) FROM run_signatures WHERE user_id = $1", [userId]);
    console.log(`AC7/8 user_id=${userId} signatures=${sigs[0].count} compared=${resLast.signals.compared_against}`);
    expect(resLast.signals.compared_against).toBe(50); // Capped at 50
  }, 60000);

  it("AC9: Determinism, writes-nothing, and [0,1] clamping", async () => {
    const userId = crypto.randomUUID();
    const runId = await seedRunStatistical(userId, generateRealisticPaceTrack()); testRunIds.push(runId);
    
    const preScoreStats = await pool.query("SELECT count(*) FROM runs");
    
    const r1 = await scoreStatistical(runId);
    const r2 = await scoreStatistical(runId);

    const postScoreStats = await pool.query("SELECT count(*) FROM runs");

    expect(r1).toEqual(r2);
    expect(preScoreStats.rows[0].count).toBe(postScoreStats.rows[0].count);
    expect(r1.score).toBeGreaterThanOrEqual(0);
    expect(r1.score).toBeLessThanOrEqual(1);
  });
});
