/**
 * src/workers/finalize_run/finalize.test.ts
 *
 * Tests for the run finalization worker (RM-3.2).
 */

import {  describe, it, expect, vi , afterEach } from 'vitest';
import crypto from "crypto";
import { pool } from "../../db/pool.js";
import { finalizeRun } from "./finalize.js";
import { seedRun } from "./__fixtures__/seed-run.js";
import {
  generateSimpleLoop,
  generateNoisyFigureEight,
  generateFigureEight,
  generateOutAndBack,
} from "../../geometry/__fixtures__/shape-tracks.js";
import { createLocalProjection } from "../../geometry/projection.js";
import type { LatLng } from "../../geometry/types.js";
import { computeXp, DAILY_GOAL_XP, DEFAULT_XP_TIMEZONE, runLines, xpDay, type ActivityRow } from "../../xp/rules.js";

// We hoist the mock of pipeline.js so we can intercept processTrack in A2
vi.mock("../../geometry/pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../geometry/pipeline.js")>();
  return {
    ...actual,
    processTrack: vi.fn(actual.processTrack),
  };
});
import { processTrack } from "../../geometry/pipeline.js";
export const testRunIds: string[] = [];
export const testUserIds: string[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getRunStatus(runId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM runs WHERE id = $1`,
    [runId]
  );
  return rows[0]?.status ?? "";
}

async function getRunRejection(runId: string): Promise<{ reason: string; detail: string } | null> {
  const { rows } = await pool.query<{ reason: string; detail: string }>(
    `SELECT reason, detail FROM run_rejections WHERE run_id = $1`,
    [runId]
  );
  return rows[0] ?? null;
}

// Generate a 10x10 m square track (area 100 m2 < 500 m2 threshold)
function generateTinyLoop(): LatLng[] {
  const proj = createLocalProjection([{ lat: 19.0, lng: 72.8 }]);
  return [
    proj.toLatLng({ x: 0, y: 0 }),
    proj.toLatLng({ x: 10, y: 0 }),
    proj.toLatLng({ x: 10, y: 10 }),
    proj.toLatLng({ x: 0, y: 10 }),
    proj.toLatLng({ x: 0, y: 0 }),
  ];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("finalizeRun Worker", () => {

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
      await pool.query("DELETE FROM activity_sessions WHERE user_id = ANY($1)", [uids]);
      await pool.query("DELETE FROM run_points WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM runs WHERE id = ANY($1)", [ids]);
      testRunIds.length = 0;
    }
  });

  it("AC1: VALID RUN > inserts exactly one territories row with owner_id = user_id and sets status finalized", async () => {
    // A clean rectangle (200x150 = 30000 m2)
    const points = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });
    const { runId, userId } = await seedRun(points); testRunIds.push(runId);

    const result = await finalizeRun(runId);

    expect(result.ok, "finalizeRun must return ok: true").toBe(true);
    if (!result.ok) return;

    // Check territories table
    const { rows: territories } = await pool.query<{ id: string; owner_id: string; state: string }>(
      `SELECT id, owner_id, state FROM territories WHERE run_id = $1`,
      [runId]
    );

    expect(territories.length).toBe(1);
    expect(territories[0]!.owner_id).toBe(userId);
    expect(territories[0]!.state).toBe("active");

    // Check run status
    expect(await getRunStatus(runId)).toBe("finalized");
  });

  describe("AC2/A3: stored area_m2 equals the area of the STORED geometry for all fixtures", () => {
    it("matches area for Simple Loop", async () => {
      const { runId } = await seedRun(generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 })); testRunIds.push(runId);
      const result = await finalizeRun(runId);
      if(!result.ok) console.log(result); expect(result.ok).toBe(true);
      const { rows } = await pool.query<{ area_m2: number; recomputed_area: number }>(`SELECT area_m2, ST_Area(geom::geography) AS recomputed_area FROM territories WHERE run_id = $1`, [runId]);
      const delta = Math.abs(rows[0]!.area_m2 - rows[0]!.recomputed_area) / rows[0]!.area_m2;
      expect(delta).toBeLessThan(0.005);
    });

    it("matches area for Clean Figure-Eight", async () => {
      const { runId } = await seedRun(generateFigureEight({ noiseStdDevM: 0, rotationDeg: 0 })); testRunIds.push(runId);
      const result = await finalizeRun(runId);
      expect(result.ok).toBe(true);
      const { rows } = await pool.query<{ area_m2: number; recomputed_area: number }>(`SELECT area_m2, ST_Area(geom::geography) AS recomputed_area FROM territories WHERE run_id = $1`, [runId]);
      const delta = Math.abs(rows[0]!.area_m2 - rows[0]!.recomputed_area) / rows[0]!.area_m2;
      expect(delta).toBeLessThan(0.005);
    });

    it("matches area for Noisy Figure-Eight", async () => {
      const { runId } = await seedRun(generateNoisyFigureEight()); testRunIds.push(runId);
      const result = await finalizeRun(runId);
      expect(result.ok).toBe(true);
      const { rows } = await pool.query<{ area_m2: number; recomputed_area: number }>(`SELECT area_m2, ST_Area(geom::geography) AS recomputed_area FROM territories WHERE run_id = $1`, [runId]);
      const delta = Math.abs(rows[0]!.area_m2 - rows[0]!.recomputed_area) / rows[0]!.area_m2;
      expect(delta).toBeLessThan(0.005);
    });

    it("matches area for Out-and-Back", async () => {
      const { runId } = await seedRun(generateOutAndBack({ noiseStdDevM: 0, rotationDeg: 0 })); testRunIds.push(runId);
      const result = await finalizeRun(runId);
      expect(result.ok).toBe(true);
      const { rows } = await pool.query<{ area_m2: number; recomputed_area: number }>(`SELECT area_m2, ST_Area(geom::geography) AS recomputed_area FROM territories WHERE run_id = $1`, [runId]);
      const delta = Math.abs(rows[0]!.area_m2 - rows[0]!.recomputed_area) / rows[0]!.area_m2;
      expect(delta).toBeLessThan(0.005);
    });
  });

  it("WALK-2: SMALL CLOSED ROUTE > finalizes as an activity but claims no territory", async () => {
    // 10x10 = 100m2 < 500m2
    const points = generateTinyLoop();
    const { runId, userId } = await seedRun(points);
 testRunIds.push(runId);

    const result = await finalizeRun(runId);

    expect(result.ok).toBe(true);

    // Check territories table
    const { rows: territories } = await pool.query<{ id: string }>(
      `SELECT id FROM territories WHERE run_id = $1`,
      [runId]
    );
    expect(territories.length).toBe(0);

    // Check runs table
    expect(await getRunStatus(runId)).toBe("finalized");

    // Check run_rejections table
    expect(await getRunRejection(runId)).toBeNull();
    const { rows: sessions } = await pool.query<{ metrics: Record<string, unknown> }>(
      "SELECT metrics FROM activity_sessions WHERE user_id = $1", [userId]
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.metrics).toMatchObject({
      territory_claimed: false,
      area_m2: 0,
      territory_reason: "below_minimum_area",
      rejection_reason: null,
    });
    expect(runLines(sessions[0]!.metrics).some((line) => line.reason === "run_completed" && line.xp === 50)).toBe(true);
  });

  it("WALK-2: NON-CLOSED WALK > finalizes, earns run XP, and records no territory claim", async () => {
    // Take 4 points from a rectangle so it has enough points to bypass the
    // insufficient_points check, but the ends are too far apart to close.
    const points = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 }).slice(0, 4);
    const { runId, userId } = await seedRun(points);
 testRunIds.push(runId);

    const result = await finalizeRun(runId);

    expect(result.ok).toBe(true);
    expect(await getRunStatus(runId)).toBe("finalized");

    expect(await getRunRejection(runId)).toBeNull();
    const { rows: sessions } = await pool.query<{ metrics: Record<string, unknown> }>(
      "SELECT metrics FROM activity_sessions WHERE user_id = $1", [userId]
    );
    expect(sessions[0]!.metrics).toMatchObject({
      territory_claimed: false,
      area_m2: 0,
      territory_reason: "not_closed",
      rejection_reason: null,
    });
    expect(runLines(sessions[0]!.metrics).reduce((sum, line) => sum + line.xp, 0)).toBeGreaterThan(0);
  });

  it("WALK-2: TOO FEW POINTS > remains rejected as an invalid activity", async () => {
    const { runId } = await seedRun(generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 }).slice(0, 3));
    testRunIds.push(runId);
    const result = await finalizeRun(runId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_points");
    expect(await getRunStatus(runId)).toBe("rejected");
    expect((await getRunRejection(runId))?.reason).toBe("insufficient_points");
  });

  it("AC5: IDEMPOTENCY > calling finalizeRun twice returns 'already_finalized'", async () => {
    const points = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });
    const { runId } = await seedRun(points); testRunIds.push(runId);

    const r1 = await finalizeRun(runId);
    expect(r1.ok).toBe(true);

    const r2 = await finalizeRun(runId);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe("already_finalized");

    // Still exactly 1 territory row
    const { rows: territories } = await pool.query<{ id: string }>(
      `SELECT id FROM territories WHERE run_id = $1`,
      [runId]
    );
    expect(territories.length).toBe(1);
  });

  it("AC6: FIGURE-EIGHT > exactly 1 territory row, ST_IsValid = true", async () => {
    const points = generateNoisyFigureEight();
    const { runId } = await seedRun(points); testRunIds.push(runId);

    const result = await finalizeRun(runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // It should have multiple faces
    expect(result.faceCount).toBeGreaterThan(1);

    const { rows } = await pool.query<{ is_valid: boolean }>(
      `SELECT ST_IsValid(geom) AS is_valid FROM territories WHERE run_id = $1`,
      [runId]
    );

    expect(rows.length).toBe(1);
    // RM-3.2b fix: Pipeline now emits valid geometry via ST_Union for all shapes
    expect(rows[0]!.is_valid).toBe(true);
  });

  it("AC7: OWNER ISOLATION > two runs with different user_ids produce distinct owner_ids", async () => {
    const p1 = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });
    const p2 = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });

    const { runId: runId1, userId: userId1 } = await seedRun(p1);
testRunIds.push(runId1);
    const { runId: runId2, userId: userId2 } = await seedRun(p2);
testRunIds.push(runId2);

    expect(userId1).not.toBe(userId2);

    await finalizeRun(runId1);
    await finalizeRun(runId2);

    const { rows } = await pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM territories WHERE run_id IN ($1, $2) ORDER BY claimed_at`,
      [runId1, runId2]
    );

    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.owner_id === userId1)).toBe(true);
    expect(rows.some((r) => r.owner_id === userId2)).toBe(true);
  });

  it("AC8: TRANSACTIONAL > rollback on territory constraint failure", async () => {
    const points = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });
    const { runId, userId } = await seedRun(points); testRunIds.push(runId);

    // To simulate a PK constraint violation on INSERT_TERRITORY,
    // we pre-insert a dummy territory and spy on randomUUID to return its ID.
    const conflictId = crypto.randomUUID();
    await pool.query(
      `
      INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, state)
      VALUES ($1, $2, $3, ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))', 4326), 1, now(), 'active')
      `,
      [conflictId, userId, runId]
    );

    const uuidSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(conflictId);

    try {
      await expect(finalizeRun(runId)).rejects.toThrow();
    } finally {
      uuidSpy.mockRestore();
    }

    expect(await getRunStatus(runId)).toBe("finishing");
  });

  it("EDGE CASE: zero points > rejects without throwing", async () => {
    const { runId } = await seedRun([]); testRunIds.push(runId);
    const result = await finalizeRun(runId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("insufficient_points");
    expect(await getRunStatus(runId)).toBe("rejected");
  });

  it("EDGE CASE: stationary points > finalize as an activity without territory", async () => {
    const { runId } = await seedRun([
      { lat: 10, lng: 10 },
      { lat: 10, lng: 10 },
      { lat: 10, lng: 10 },
      { lat: 10, lng: 10 },
      { lat: 10, lng: 10 },
    ]);
    const result = await finalizeRun(runId);

    expect(result.ok).toBe(true);
    expect(await getRunStatus(runId)).toBe("finalized");
  });

  // --- RM-6.4 + RM-3.2a tests ---

  it("A2: Consistency guard fires when area mismatches by > 0.5%", async () => {
    const points = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });
    const { runId, userId } = await seedRun(points); testRunIds.push(runId);

    let mockEnabled = true;
    const originalProcessTrack = (await vi.importActual('../../geometry/pipeline.js') as any).processTrack;
    vi.mocked(processTrack).mockImplementation(async (pts) => {
      const res = await originalProcessTrack(pts);
      if (res.ok && mockEnabled) {
        res.areaM2 = res.areaM2 * 1.1; // Force 10% mismatch
        mockEnabled = false;
      }
      return res;
    });

    const result = await finalizeRun(runId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("area_geometry_mismatch");

    // Verify no territory was inserted
    const { rows: territories } = await pool.query(`SELECT id FROM territories WHERE run_id = $1`, [runId]);
    expect(territories.length).toBe(0);
    expect(await getRunStatus(runId)).toBe("rejected");

    vi.mocked(processTrack).mockRestore();

    // Verify activity_session was STILL created for the rejected run
    const { rows: activities } = await pool.query<{ id: string; metrics: Record<string, unknown> }>(
      `SELECT id, metrics FROM activity_sessions WHERE user_id = $1`,
      [userId]
    );
    expect(activities.length).toBe(1);
    expect(activities[0]!.metrics["rejection_reason"]).toBe("area_geometry_mismatch");
  });

  it("B1-B5: VALID run produces exactly one activity_sessions row with correct metrics", async () => {
    const points = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });
    const { runId, userId } = await seedRun(points); testRunIds.push(runId);
    await finalizeRun(runId);

    const { rows } = await pool.query<{
      id: string; type: string; subtype: string; duration_s: number;
      intensity: string; calories_kcal: number | null; source_module: string;
      metrics: Record<string, unknown>;
    }>(`SELECT * FROM activity_sessions WHERE user_id = $1`, [userId]);
    expect(rows.length).toBe(1);

    const row = rows[0]!;
    expect(row.type).toBe("run");
    expect(row.subtype).toBe("territory_run");
    expect(row.duration_s).toBe(60);
    expect(row.intensity).toBe("moderate"); // 100m / 60s = 1.66 m/s -> moderate
    expect(row.calories_kcal).toBeNull();
    expect(row.source_module).toBe("run_module");
    expect(row.metrics["territory_claimed"]).toBe(true);
    expect(row.metrics["area_m2"]).toBeGreaterThan(0);
    expect(row.metrics["rejection_reason"]).toBeNull();
  });

  it("F2: a run claimed three days earlier earns XP on its earliest recorded point day", async () => {
    const points = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });
    const { runId, userId } = await seedRun(points);
    testRunIds.push(runId);
    testUserIds.push(userId);
    await pool.query("UPDATE runs SET started_at = started_at - interval '3 days' WHERE id = $1", [runId]);

    const firstPoint = await pool.query<{ first_point_at: Date }>(
      "SELECT min(recorded_at) AS first_point_at FROM run_points WHERE run_id = $1", [runId]
    );
    await finalizeRun(runId);

    const activity = await pool.query<ActivityRow>(
      `SELECT id, type, source_module, started_at, duration_s, metrics, created_at
       FROM activity_sessions WHERE user_id = $1 AND source_module = 'run_module'`, [userId]
    );
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]!.started_at.getTime()).toBe(firstPoint.rows[0]!.first_point_at.getTime());
    const xp = computeXp([activity.rows[0]!]);
    expect(xp.byDay).toHaveProperty(xpDay(firstPoint.rows[0]!.first_point_at, DEFAULT_XP_TIMEZONE));

    const secondRunSameDay = {
      ...activity.rows[0]!,
      id: crypto.randomUUID(),
      created_at: new Date(activity.rows[0]!.created_at.getTime() + 1000),
    };
    expect(computeXp([activity.rows[0]!, secondRunSameDay]).xp).toBeLessThanOrEqual(150 + DAILY_GOAL_XP); // run cap + the day's goal
  });

  it("carries the run's time zone into its activity row, so XP days are the runner's own", async () => {
    const points = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });
    const { runId, userId } = await seedRun(points); testRunIds.push(runId);
    await pool.query("UPDATE runs SET timezone = 'Asia/Kolkata' WHERE id = $1", [runId]);
    await finalizeRun(runId);
    const { rows } = await pool.query<{ metrics: Record<string, unknown> }>(
      `SELECT metrics FROM activity_sessions WHERE user_id = $1`, [userId]);
    expect(rows[0]!.metrics["timezone"]).toBe("Asia/Kolkata");
  });

  it("B1-B5: no-territory run produces one activity_sessions row without a rejection reason", async () => {
    // 10x10 = 100m2 < 500m2 -> no territory, but a valid activity
    const points = generateTinyLoop();
    const { runId, userId } = await seedRun(points); testRunIds.push(runId);
    await finalizeRun(runId);

    const { rows } = await pool.query<{ metrics: Record<string, unknown> }>(
      `SELECT metrics FROM activity_sessions WHERE user_id = $1`,
      [userId]
    );
    expect(rows.length).toBe(1);

    const row = rows[0]!;
    expect(row.metrics["territory_claimed"]).toBe(false);
    expect(row.metrics["area_m2"]).toBe(0);
    expect(row.metrics["rejection_reason"]).toBeNull();
    expect(row.metrics["territory_reason"]).toBe("below_minimum_area");
  });

  it("B1-B5: duration_s is derived from points when elapsed_time_s is null", async () => {
    const points = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 }).slice(0, 2);
    const { runId, userId } = await seedRun(points, undefined, { elapsedTimeS: null }); testRunIds.push(runId);
    await finalizeRun(runId);

    // Distance is 200m. 200m / 3m/s = 66 seconds.
    const { rows } = await pool.query<{ duration_s: number }>(
      `SELECT duration_s FROM activity_sessions WHERE user_id = $1`,
      [userId]
    );
    expect(rows[0]!.duration_s).toBe(66);
  });
});
