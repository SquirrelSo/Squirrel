import {  describe, it, expect, vi, beforeEach , afterEach } from 'vitest';
import { scoreRun } from "./aggregate.js";
import { pool } from "../db/pool.js";
import { finalizeRun } from "../workers/finalize_run/finalize.js";
import crypto from "crypto";
import {
  generateNormalRunnerTrack,
  generateMockProviderTrack,
  generateImpossibleUploadRun,
  generateOverlappingRunPair,
  generateConstantSpeedTrack,
  generateSlowerReplayTrack,
  generateAdjacentRunPair,
  generateOfflineUploadRun,
  generateRealisticPaceTrack,
  generateTeleportTrack,
  generateLowAccuracyTrack,
  generateJitteredReplayTrack,
  TrackPoint
} from "./__fixtures__/motion-tracks.js";

vi.setConfig({ testTimeout: 30000 });

// We mock the DB for boundary tests? No, boundary tests can just mock the scoring functions.
vi.mock('./platform.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./platform.js')>();
  return { ...mod, scorePlatform: vi.fn(mod.scorePlatform) };
});
vi.mock('./temporal.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./temporal.js')>();
  return { ...mod, scoreTemporal: vi.fn(mod.scoreTemporal) };
});
vi.mock('./statistical.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./statistical.js')>();
  return { ...mod, scoreStatistical: vi.fn(mod.scoreStatistical) };
});
vi.mock('./kinematic.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./kinematic.js')>();
  return { ...mod, scoreKinematic: vi.fn(mod.scoreKinematic) };
});
vi.mock('./signal-quality.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./signal-quality.js')>();
  return { ...mod, scoreSignalQuality: vi.fn(mod.scoreSignalQuality) };
});

import { scorePlatform } from './platform.js';
import { scoreTemporal } from './temporal.js';
import { scoreStatistical } from './statistical.js';
import { scoreKinematic } from './kinematic.js';
import { scoreSignalQuality } from './signal-quality.js';
export const testRunIds: string[] = [];
export const testUserIds: string[] = [];

async function seedRunAgg(userId: string, points: TrackPoint[], mockBatches = true): Promise<string> {
  const runId = crypto.randomUUID(); testRunIds.push(runId);  testRunIds.push(runId);
    testRunIds.push(runId);
    if (!testUserIds.includes(userId)) testUserIds.push(userId);
  await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'active', now())", [runId, userId]);
  let baseTime = Date.now() - 3600000;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    await pool.query(
      `INSERT INTO run_points (run_id, seq, lat, lng, recorded_at, accuracy_m) VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, i, p.lat, p.lng, p.recorded_at || new Date(baseTime + i * 1000), p.accuracy_m ?? 5]
    );
    if (p.is_mock) {
      await pool.query(`INSERT INTO run_point_flags (run_id, seq, is_mock) VALUES ($1, $2, true)`, [runId, i]);
    }
  }
  if (mockBatches) {
    await pool.query(
      `INSERT INTO run_batches (id, run_id, point_count, first_seq, last_seq, uploaded_at) VALUES ($1, $2, $3, $4, $5, now())`,
      [crypto.randomUUID(), runId, points.length, 0, points.length - 1]
    );
  }
  await pool.query("UPDATE runs SET status = 'finishing' WHERE id = $1", [runId]);
  return runId;
}

describe("Aggregate Scoring and Routing", () => {

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

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("AC1: SPEC CRITERION: each of the five layers' decisive fixtures routes to the expected band", async () => {
    const userMock = crypto.randomUUID();
    const mockRun = await seedRunAgg(userMock, generateMockProviderTrack()); testRunIds.push(mockRun);
    await finalizeRun(mockRun);

    const userImp = crypto.randomUUID();
    const impRun = await seedRunAgg(userImp, generateImpossibleUploadRun()); testRunIds.push(impRun);
    await finalizeRun(impRun);

    const userExact = crypto.randomUUID();
    const baseExact = generateNormalRunnerTrack();
    await finalizeRun(await seedRunAgg(userExact, baseExact));
    const exactRun = await seedRunAgg(userExact, baseExact); testRunIds.push(exactRun);
    await finalizeRun(exactRun);

    const userTele = crypto.randomUUID();
    const teleRun = await seedRunAgg(userTele, generateTeleportTrack()); testRunIds.push(teleRun);
    await finalizeRun(teleRun);

    const userLow = crypto.randomUUID();
    const lowRun = await seedRunAgg(userLow, generateLowAccuracyTrack()); testRunIds.push(lowRun);
    await finalizeRun(lowRun);

    const userJit = crypto.randomUUID();
    const baseJit = generateNormalRunnerTrack();
    await finalizeRun(await seedRunAgg(userJit, baseJit));
    const jitRun = await seedRunAgg(userJit, generateJitteredReplayTrack()); testRunIds.push(jitRun);
    await finalizeRun(jitRun);

    const userConst = crypto.randomUUID();
    const constRun = await seedRunAgg(userConst, generateConstantSpeedTrack()); testRunIds.push(constRun);
    await finalizeRun(constRun);

    const userOver = crypto.randomUUID();
    const [t1, t2] = generateOverlappingRunPair();
    await finalizeRun(await seedRunAgg(userOver, t1));
    const overRun = await seedRunAgg(userOver, t2); testRunIds.push(overRun);
    await finalizeRun(overRun);

    const userClean = crypto.randomUUID();
    const cleanRun = await seedRunAgg(userClean, generateRealisticPaceTrack()); testRunIds.push(cleanRun);
    await finalizeRun(cleanRun);

    const getScore = async (r: string) => {
      const res = await pool.query("SELECT aggregate, band, layers FROM run_scores WHERE run_id = $1", [r]);
      if(res.rowCount === 0) return null;
      let dec = null;
      if (res.rows[0].aggregate === 0.0) {
        dec = res.rows[0].layers.find((l: any) => l.score === 0.0)?.layer;
      }
      return { ...res.rows[0], decisiveLayer: dec };
    };

    console.log("=== AC1 FIXTURE ROUTING TABLE ===");
    const table = [
      { fixture: 'mock-provider track', ...await getScore(mockRun) },
      { fixture: 'impossible-upload run', ...await getScore(impRun) },
      { fixture: 'exact replay', ...await getScore(exactRun) },
      { fixture: 'car-speed track', ...await getScore(teleRun) },
      { fixture: 'low-accuracy track', ...await getScore(lowRun) },
      { fixture: 'jittered replay', ...await getScore(jitRun) },
      { fixture: 'constant-speed track', ...await getScore(constRun) },
      { fixture: 'overlapping run', ...await getScore(overRun) },
      { fixture: 'realistic clean run', ...await getScore(cleanRun) }
    ];
    console.table(table);

      // Assertions for AC1
      expect(table[0].band).toBe('reject'); expect(table[0].decisiveLayer).toBe('platform');
      expect(table[1].band).toBe('reject'); expect(table[1].decisiveLayer).toBe('temporal');
      expect(table[2].band).toBe('reject'); expect(table[2].decisiveLayer).toBe('statistical');
      expect(table[3].band).toBe('reject'); // teleport -> kinematic
      expect(table[4].band).toBe('reject'); // low accuracy -> signal-quality
      expect(table[5].band).toBe('pending');
      expect(table[6].band).toBe('pending');
      
      // Overlapping run (Priority 3)
      console.log("Layers for Overlapping run:", JSON.stringify(table[7].layers, null, 2));
      expect(table[7].aggregate).toBe(0.6);
      expect(table[7].band).toBe('pending');
      const tempLayer = table[7].layers.find((l: any) => l.layer === 'temporal');
      expect(tempLayer.score).toBe(0.6);
      // Ensure all other layers are higher or equal
      table[7].layers.forEach((l: any) => {
        expect(l.score).toBeGreaterThanOrEqual(0.6);
      });

      expect(table[8].band).toBe('accept');
  });

  it("AC2: a REJECTED run inserts NO territories row", async () => {
    const user = crypto.randomUUID();
    const run = await seedRunAgg(user, generateMockProviderTrack()); testRunIds.push(run);
    await finalizeRun(run);

    const tRes = await pool.query("SELECT * FROM territories WHERE run_id = $1", [run]);
    expect(tRes.rowCount).toBe(0);

    const rRes = await pool.query("SELECT status FROM runs WHERE id = $1", [run]);
    expect(rRes.rows[0].status).toBe('rejected');

    const rejRes = await pool.query("SELECT * FROM run_rejections WHERE run_id = $1", [run]);
    expect(rejRes.rowCount).toBe(1);
    expect(rejRes.rows[0].reason).toBe('anticheat_rejected');
  });

  it("AC3: A PENDING run DOES insert a territory row, with status 'flagged'", async () => {
    const user = crypto.randomUUID();
    const [t1, t2] = generateOverlappingRunPair();
    
    const r1 = await finalizeRun(await seedRunAgg(user, t1));
    if (!r1.ok) console.log("T1 failed:", r1);

    const run = await seedRunAgg(user, t2); testRunIds.push(run);
    const r2 = await finalizeRun(run);
    if (!r2.ok) console.log("T2 failed:", r2);

    const tRes = await pool.query("SELECT * FROM territories WHERE run_id = $1", [run]);
    expect(tRes.rowCount).toBe(1);
    console.log("AC3 Territory row inserted:", tRes.rows[0]);

    const rRes = await pool.query("SELECT status FROM runs WHERE id = $1", [run]);
    expect(rRes.rows[0].status).toBe('flagged');
    console.log("AC3 Run status:", rRes.rows[0].status);
  });

  it("AC4: An ACCEPTED run behaves exactly as before: territory inserted, status 'finalized'", async () => {
    const user = crypto.randomUUID();
    const run = await seedRunAgg(user, generateRealisticPaceTrack()); testRunIds.push(run);
    const r = await finalizeRun(run);
    if (!r.ok) console.log("AC4 failed:", r);

    const tRes = await pool.query("SELECT * FROM territories WHERE run_id = $1", [run]);
    expect(tRes.rowCount).toBe(1);

    const rRes = await pool.query("SELECT status FROM runs WHERE id = $1", [run]);
    expect(rRes.rows[0].status).toBe('finalized');
  });

  it("AC5: Every one of the three outcomes writes exactly one activity_sessions row, with band present", async () => {
    const user = crypto.randomUUID();
    const r1 = await seedRunAgg(user, generateMockProviderTrack()); testRunIds.push(r1);
    await finalizeRun(r1);
    let sRes = await pool.query("SELECT * FROM activity_sessions WHERE user_id = $1", [user]);
    expect(sRes.rowCount).toBe(1);
    expect(sRes.rows[0].metrics.band).toBe('reject');
    console.log("AC5 Session (Reject):", sRes.rows[0]);

    const user2 = crypto.randomUUID();
    const r2 = await seedRunAgg(user2, generateConstantSpeedTrack()); testRunIds.push(r2);
    await finalizeRun(r2);
    sRes = await pool.query("SELECT * FROM activity_sessions WHERE user_id = $1", [user2]);
    expect(sRes.rowCount).toBe(1);
    expect(sRes.rows[0].metrics.band).toBe('pending');
    console.log("AC5 Session (Pending):", sRes.rows[0]);

    const user3 = crypto.randomUUID();
    const r3 = await seedRunAgg(user3, generateRealisticPaceTrack()); testRunIds.push(r3);
    await finalizeRun(r3);
    sRes = await pool.query("SELECT * FROM activity_sessions WHERE user_id = $1", [user3]);
    expect(sRes.rowCount).toBe(1);
    expect(sRes.rows[0].metrics.band).toBe('accept');
    console.log("AC5 Session (Accept):", sRes.rows[0]);
  });

  it("AC6: Every one of the three outcomes writes exactly one run_scores row", async () => {
    const user = crypto.randomUUID();
    const r3 = await seedRunAgg(user, generateNormalRunnerTrack()); testRunIds.push(r3);
    await finalizeRun(r3);
    
    const sc = await pool.query("SELECT * FROM run_scores WHERE run_id = $1", [r3]);
    expect(sc.rowCount).toBe(1);
    expect(sc.rows[0].layers).toHaveLength(5);
  });

  it("AC7, AC8, AC9: Math.min semantics, zero-override, and boundary tests", async () => {
    // Mock the functions to return specific scores
    const mockScores = (scores: number[]) => {
      vi.mocked(scorePlatform).mockResolvedValue({ layer: 'platform', score: scores[0] ?? 0, signals: {}, sampleCount: 0 });
      vi.mocked(scoreTemporal).mockResolvedValue({ layer: 'temporal', score: scores[1] ?? 0, signals: {}, sampleCount: 0 });
      vi.mocked(scoreStatistical).mockResolvedValue({ layer: 'statistical', score: scores[2] ?? 0, signals: {}, sampleCount: 0 });
      vi.mocked(scoreKinematic).mockResolvedValue({ layer: 'kinematic', score: scores[3] ?? 0, signals: {}, sampleCount: 0 });
      vi.mocked(scoreSignalQuality).mockResolvedValue({ layer: 'signal-quality', score: scores[4] ?? 0, signals: {}, sampleCount: 0 });
    };

    // AC7: 1.0, 1.0, 1.0, 0.6, 1.0 -> 0.6 pending
    mockScores([1.0, 1.0, 1.0, 0.6, 1.0]);
    let res = await scoreRun('test-id');
    expect(res.aggregate).toBe(0.6);
    expect(res.band).toBe('pending');
    console.log(`Boundary 1: [1.0, 1.0, 1.0, 0.6, 1.0] -> Aggregate: ${res.aggregate}, Band: ${res.band}`);

    // AC8: zero override
    mockScores([1.0, 1.0, 0.0, 1.0, 1.0]);
    res = await scoreRun('test-id');
    expect(res.aggregate).toBe(0.0);
    expect(res.band).toBe('reject');
    console.log(`Boundary 2: [1.0, 1.0, 0.0, 1.0, 1.0] -> Aggregate: ${res.aggregate}, Band: ${res.band}`);

    // All clean
    mockScores([0.9, 0.9, 0.9, 0.9, 0.9]);
    res = await scoreRun('test-id');
    expect(res.aggregate).toBe(0.9);
    expect(res.band).toBe('accept');
    console.log(`Boundary 3: [0.9, 0.9, 0.9, 0.9, 0.9] -> Aggregate: ${res.aggregate}, Band: ${res.band}`);

    // Just below accept
    mockScores([1.0, 1.0, 0.7, 1.0, 1.0]);
    res = await scoreRun('test-id');
    expect(res.aggregate).toBe(0.7);
    expect(res.band).toBe('pending');
    console.log(`Boundary 4: [1.0, 1.0, 0.7, 1.0, 1.0] -> Aggregate: ${res.aggregate}, Band: ${res.band}`);

    mockScores([0.7, 1.0, 1.0, 1.0, 1.0]);
    res = await scoreRun('test-id');
    expect(res.aggregate).toBe(0.7);
    expect(res.band).toBe('pending');

    mockScores([0.701, 1.0, 1.0, 1.0, 1.0]);
    res = await scoreRun('test-id');
    expect(res.aggregate).toBe(0.701);
    expect(res.band).toBe('accept');
  });

  it("AC10: A geometrically invalid run is still rejected by geometry and produces NO run_scores row", async () => {
    const user = crypto.randomUUID();
    const p = generateNormalRunnerTrack();
    const run = await seedRunAgg(user, p.slice(0, 3)); // 3 points = invalid testRunIds.push(run);
    await finalizeRun(run);

    const sc = await pool.query("SELECT * FROM run_scores WHERE run_id = $1", [run]);
    expect(sc.rowCount).toBe(0);
    console.log("AC10 run_scores rowCount (expected 0):", sc.rowCount);

    const rRes = await pool.query("SELECT status FROM runs WHERE id = $1", [run]);
    expect(rRes.rows[0].status).toBe('rejected');
    console.log("AC10 Run status:", rRes.rows[0].status);
  });

  it("AC12: Idempotency: finalizing twice produces exactly one run_scores row", async () => {
    const user = crypto.randomUUID();
    const run = await seedRunAgg(user, generateNormalRunnerTrack()); testRunIds.push(run);
    await finalizeRun(run);
    
    // Attempt second finalize
    const r2 = await finalizeRun(run);
    expect(r2.ok).toBe(false);
    console.log("AC12 second finalize result:", r2);
    
    const sc = await pool.query("SELECT * FROM run_scores WHERE run_id = $1", [run]);
    expect(sc.rowCount).toBe(1);
    console.log("AC12 run_scores rowCount:", sc.rowCount);
  });
});
