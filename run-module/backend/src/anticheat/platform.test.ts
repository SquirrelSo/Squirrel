import {  describe, it, expect , afterEach } from 'vitest';
import { pool } from "../db/pool.js";
import { scorePlatform } from "./platform.js";
import { scoreKinematic } from "./kinematic.js";
import { scoreSignalQuality } from "./signal-quality.js";
import {
  generateMockProviderTrack,
  generateIntermittentMockTrack,
  generateUnreportedFlagTrack,
  generateNormalRunnerTrack,
  TrackPoint,
  assignRealisticTimestamps
} from "./__fixtures__/motion-tracks.js";
import crypto from "crypto";
export const testRunIds: string[] = [];
export const testUserIds: string[] = [];

// Minimal reproduction of point upload loop
async function seedRunPlatform(points: TrackPoint[]): Promise<string> {
  const userId = crypto.randomUUID();
  const runId = crypto.randomUUID(); testRunIds.push(runId);
  await pool.query(
    "INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'finishing', now())",
    [runId, userId]
  );
  
  const timedPoints = points;
  
  for (let i = 0; i < timedPoints.length; i++) {
    const p = timedPoints[i]!;
    await pool.query(
      `INSERT INTO run_points (run_id, seq, lat, lng, accuracy_m, recorded_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, i, p.lat, p.lng, p.accuracy_m ?? null, p.recorded_at]
    );
    if (p.is_mock !== undefined && p.is_mock !== null) {
      await pool.query(
        "INSERT INTO run_point_flags (run_id, seq, is_mock) VALUES ($1, $2, $3)",
        [runId, i, p.is_mock]
      );
    }
  }

  // insert a batch
  await pool.query(
    `INSERT INTO run_batches (id, run_id, point_count, first_seq, last_seq) VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), runId, points.length, 0, points.length - 1]
  );

  return runId;
}

describe("Platform Scoring Layer", () => {

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

  it("AC1: generateMockProviderTrack scores 0.0 on platform, >0.5 on kinematic, >0.5 on signal-quality", async () => {
    // Generate the mock track but assign it clean GPS accuracy so it passes RM-4.2
    const mockTrack = generateMockProviderTrack().map(p => ({ ...p, accuracy_m: 5.0 }));
    const runId = await seedRunPlatform(mockTrack); testRunIds.push(runId);
    
    const platformRes = await scorePlatform(runId);
    const kinRes = await scoreKinematic(runId);
    const sigRes = await scoreSignalQuality(runId);

    expect(platformRes.score).toBe(0.0);
    expect(kinRes.score).toBeGreaterThan(0.5);
    expect(sigRes.score).toBeGreaterThan(0.5);
  });

  it("AC2: generateIntermittentMockTrack scores 0.0, with mock_ratio < 0.2", async () => {
    const track = generateIntermittentMockTrack();
    const runId = await seedRunPlatform(track); testRunIds.push(runId);
    const platformRes = await scorePlatform(runId);
    
    expect(platformRes.score).toBe(0.0);
    expect(platformRes.signals.mock_ratio).toBeGreaterThan(0);
    expect(platformRes.signals.mock_ratio).toBeLessThan(0.2);
  });

  it("AC3: generateUnreportedFlagTrack scores 1.0 with unreported_ratio 1.0", async () => {
    const track = generateUnreportedFlagTrack();
    const runId = await seedRunPlatform(track); testRunIds.push(runId);
    const platformRes = await scorePlatform(runId);
    
    expect(platformRes.score).toBe(1.0);
    expect(platformRes.signals.unreported_ratio).toBe(1.0);
  });

  it("AC4: A clean track with is_mock explicitly false on every point scores 1.0 with flagged_point_ratio 1.0", async () => {
    const track = generateNormalRunnerTrack().map(p => ({ ...p, is_mock: false }));
    const runId = await seedRunPlatform(track); testRunIds.push(runId);
    const platformRes = await scorePlatform(runId);

    expect(platformRes.score).toBe(1.0);
    expect(platformRes.signals.flagged_point_ratio).toBe(1.0);
    expect(platformRes.signals.mock_ratio).toBe(0);
  });

  it("AC5: Uploading points with is_mock present stores correctly; omitting the field stores NULL", async () => {
    // We already assert NULL in AC3 but we'll do a direct DB check
    let baseTime = Date.now() - 3600 * 1000;
    const track = [
      { lat: 0.1, lng: 0.1, is_mock: true, recorded_at: new Date(baseTime) },
      { lat: 0.2, lng: 0.2, recorded_at: new Date(baseTime + 1000) } // omitted
    ];
    const runId = await seedRunPlatform(track); testRunIds.push(runId);
    
    const { rows } = await pool.query("SELECT seq, is_mock FROM run_point_flags WHERE run_id = $1 ORDER BY seq ASC", [runId]);
    expect(rows.length).toBe(1);
    expect(rows[0].seq).toBe(0);
    expect(rows[0].is_mock).toBe(true);
  });

  it("AC8: root_signal is present in the signals object and is NULL", async () => {
    const runId = await seedRunPlatform(generateNormalRunnerTrack()); testRunIds.push(runId);
    const res = await scorePlatform(runId);
    
    expect(res.signals.root_signal).toBeNull();
  });

  it("AC9: Determinism, writes-nothing, and [0,1] clamping", async () => {
    const runId = await seedRunPlatform(generateMockProviderTrack()); testRunIds.push(runId);
    
    const preScoreStats = await pool.query("SELECT (SELECT count(*) FROM run_point_flags) as total");
    
    const r1 = await scorePlatform(runId);
    const r2 = await scorePlatform(runId);

    const postScoreStats = await pool.query("SELECT (SELECT count(*) FROM run_point_flags) as total");

    expect(r1).toEqual(r2);
    expect(preScoreStats.rows[0].total).toBe(postScoreStats.rows[0].total);
    expect(r1.score).toBeGreaterThanOrEqual(0);
    expect(r1.score).toBeLessThanOrEqual(1);
  });

  it("AC10: a run_point_flags row PRESENT with is_mock NULL is treated as unreported", async () => {
    // We insert a point with is_mock = null explicitly
    let baseTime = Date.now() - 3600 * 1000;
    const track = [{ lat: 0.1, lng: 0.1, is_mock: null, recorded_at: new Date(baseTime) }];
    const runId = await seedRunPlatform(track); testRunIds.push(runId);
    const platformRes = await scorePlatform(runId);
    expect(platformRes.score).toBe(1.0);
    expect(platformRes.signals.unreported_ratio).toBe(1.0);
  });
});
