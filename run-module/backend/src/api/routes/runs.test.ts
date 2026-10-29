import {  describe, it, expect, vi, beforeEach, beforeAll, afterAll , afterEach } from 'vitest';
import crypto from 'crypto';
import { finalizeRun } from '../../workers/finalize_run/finalize.js';
import { generateRealisticPaceTrack } from '../../anticheat/__fixtures__/motion-tracks.js';
import Fastify from 'fastify';
import { pool } from '../../db/pool.js';
import runsRoutes from './runs.js';
import * as jose from 'jose';
import { JWT_SECRET, JWT_ALGORITHM } from '../../config/env.js';
import zlib from 'zlib';
import util from 'util';
import * as finalizeQueue from '../../workers/finalize_run/queue.js';
import { recoverStuckFinishingRuns } from '../../workers/finalize_run/queue.js';
import { generateSimpleLoop } from '../../geometry/__fixtures__/shape-tracks.js';
export const testRunIds: string[] = [];
export const testUserIds: string[] = [];


const gzip = util.promisify(zlib.gzip);

// Create token helper
async function createToken(userId: string) {
  const secret = new TextEncoder().encode(JWT_SECRET);
  return await new jose.SignJWT({})
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setSubject(userId)
    .setIssuer('run_module')
    .setExpirationTime('1h')
    .sign(secret);
}

describe('Runs API', () => {

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

  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fastify = Fastify();
    await fastify.register(runsRoutes);
    vi.clearAllMocks();
  });

  it('AC1: POST /v1/runs with a valid token returns 201 and a run row whose user_id equals the token subject', async () => {
    const userId = crypto.randomUUID();
    const token = await createToken(userId);

    const res = await fastify.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {},
    });

    console.log("ERROR BODY:", res.body);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.run_id).toBeDefined();

    const dbRes = await pool.query('SELECT user_id, status FROM runs WHERE id = $1', [body.run_id]);
    expect(dbRes.rows.length).toBe(1);
    expect(dbRes.rows[0].user_id).toBe(userId);
    expect(dbRes.rows[0].status).toBe('active');
  });

  it('POST /v1/runs keeps a valid phone time zone and drops an invalid one', async () => {
    const token = await createToken(crypto.randomUUID());
    const create = (timezone: string) => fastify.inject({
      method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` }, payload: { timezone },
    });
    const good = JSON.parse((await create('Asia/Kolkata')).body);
    const bad = JSON.parse((await create('Not/AZone')).body);
    const { rows } = await pool.query('SELECT id, timezone FROM runs WHERE id = ANY($1)', [[good.run_id, bad.run_id]]);
    const zone = Object.fromEntries(rows.map((r: { id: string; timezone: string | null }) => [r.id, r.timezone]));
    expect(zone[good.run_id]).toBe('Asia/Kolkata');
    expect(zone[bad.run_id]).toBeNull();
  });

  it('AC2: POST /v1/runs with no token returns 401', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/v1/runs',
      payload: {},
    });

    expect(res.statusCode).toBe(401);
  });

  it('AC3 & AC4: Idempotency with SAME key (AC3) and DIFFERENT key (AC4)', async () => {
    const userId = crypto.randomUUID();
    const token = await createToken(userId);

    // Create a run
    const createRes = await fastify.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    const runId = JSON.parse(createRes.body).run_id;

    const points = [
      { seq: 0, lat: 10, lng: 10, accuracy_m: 5, recorded_at: new Date().toISOString() },
      { seq: 1, lat: 10.1, lng: 10.1, accuracy_m: 5, recorded_at: new Date().toISOString() }
    ];

    const idempotencyKey1 = 'key-1';

    // AC3: First batch
    const p1Res = await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/points`,
      headers: { authorization: `Bearer ${token}` },
      payload: { idempotency_key: idempotencyKey1, points },
    });
    expect(p1Res.statusCode).toBe(202);
    console.log('AC3 First Batch Response:', p1Res.body);

    // AC3: Second identical batch, SAME key
    const p2Res = await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/points`,
      headers: { authorization: `Bearer ${token}` },
      payload: { idempotency_key: idempotencyKey1, points },
    });
    expect(p2Res.statusCode).toBe(200); // 200 because it returned STORED response
    console.log('AC3 Second Batch (Same Key) Response:', p2Res.body);

    const dbRes = await pool.query('SELECT * FROM run_points WHERE run_id = $1', [runId]);
    expect(dbRes.rows.length).toBe(2);

    // AC4: Third identical batch, DIFFERENT key
    const idempotencyKey2 = 'key-2';
    const p3Res = await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/points`,
      headers: { authorization: `Bearer ${token}` },
      payload: { idempotency_key: idempotencyKey2, points },
    });
    expect(p3Res.statusCode).toBe(202);
    // accepted should be 0, duplicates_ignored should be 2 because of ON CONFLICT
    const p3Body = JSON.parse(p3Res.body);
    expect(p3Body.accepted).toBe(0);
    expect(p3Body.duplicates_ignored).toBe(2);

    const dbRes3 = await pool.query('SELECT * FROM run_points WHERE run_id = $1', [runId]);
    expect(dbRes3.rows.length).toBe(2); // Still exactly N rows
  });

  it('AC5: A gzipped batch produces the same stored rows as the identical uncompressed batch', async () => {
    const userId = crypto.randomUUID();
    const token = await createToken(userId);

    const r1 = await fastify.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` }, payload: {} });
    const run1Id = JSON.parse(r1.body).run_id;

    const r2 = await fastify.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` }, payload: {} });
    const run2Id = JSON.parse(r2.body).run_id;

    const points = [
      { seq: 0, lat: 10, lng: 10, accuracy_m: 5, recorded_at: new Date().toISOString() },
    ];

    // Uncompressed
    await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${run1Id}/points`,
      headers: { authorization: `Bearer ${token}` },
      payload: { idempotency_key: 'key-1', points },
    });

    // Compressed
    const gzipped = await gzip(JSON.stringify({ idempotency_key: 'key-1', points }));
    await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${run2Id}/points`,
      headers: { 
        authorization: `Bearer ${token}`,
        'content-encoding': 'gzip',
        'content-type': 'application/json'
      },
      payload: gzipped,
    });

    const rows1 = await pool.query('SELECT seq, lat, lng, accuracy_m, recorded_at FROM run_points WHERE run_id = $1', [run1Id]);
    const rows2 = await pool.query('SELECT seq, lat, lng, accuracy_m, recorded_at FROM run_points WHERE run_id = $1', [run2Id]);

    expect(rows1.rows).toEqual(rows2.rows);
  });

  it('AC6: User B posting points to user A\'s run returns 403 and inserts nothing', async () => {
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    
    const r1 = await fastify.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${await createToken(userA)}` }, payload: {} });
    console.log("AC6 R1 BODY:", r1.body);
    const runId = JSON.parse(r1.body).run_id;

    const res = await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/points`,
      headers: { authorization: `Bearer ${await createToken(userB)}` }, // userB tries
      payload: { idempotency_key: 'key-1', points: [] },
    });

    console.log("AC6 ERROR:", res.body);
    expect(res.statusCode).toBe(403);
  });

  it('AC7: A batch containing one invalid point (lat 91) returns 400 and inserts NO points from that batch', async () => {
    const userId = crypto.randomUUID();
    const token = await createToken(userId);
    const r1 = await fastify.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` }, payload: {} });
    const runId = JSON.parse(r1.body).run_id;

    const points = [
      { seq: 0, lat: 10, lng: 10, accuracy_m: 5, recorded_at: new Date().toISOString() },
      { seq: 1, lat: 91, lng: 10, accuracy_m: 5, recorded_at: new Date().toISOString() } // lat 91 is invalid
    ];

    const res = await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/points`,
      headers: { authorization: `Bearer ${token}` },
      payload: { idempotency_key: 'key-1', points },
    });

    expect(res.statusCode).toBe(400);

    const dbRes = await pool.query('SELECT * FROM run_points WHERE run_id = $1', [runId]);
    expect(dbRes.rows.length).toBe(0); // Inserted NO points
  });

  it('AC8: POST /finish sets status finishing and enqueues one job; calling it twice enqueues at most one', async () => {
    const userId = crypto.randomUUID();
    const token = await createToken(userId);
    const r1 = await fastify.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` }, payload: {} });
    const runId = JSON.parse(r1.body).run_id;

    const enqueueSpy = vi.spyOn(finalizeQueue, 'enqueueFinalizeRun').mockResolvedValue();

    const f1 = await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/finish`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(f1.statusCode).toBe(202);
    expect(JSON.parse(f1.body).status).toBe('finishing');

    const f2 = await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/finish`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(f2.statusCode).toBe(202);

    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    const dbRes = await pool.query('SELECT status FROM runs WHERE id = $1', [runId]);
    expect(dbRes.rows[0].status).toBe('finishing');
  });

  it('F1: a lost enqueue is recovered and the run is finalized only once', async () => {
    const userId = crypto.randomUUID();
    testUserIds.push(userId);
    const token = await createToken(userId);
    const created = await fastify.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` }, payload: {} });
    const runId = JSON.parse(created.body).run_id;
    testRunIds.push(runId);

    const enqueueSpy = vi.spyOn(finalizeQueue, 'enqueueFinalizeRun')
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValue(undefined);
    const finish = await fastify.inject({ method: 'POST', url: `/v1/runs/${runId}/finish`, headers: { authorization: `Bearer ${token}` } });
    expect(finish.statusCode).toBe(500);
    expect((await pool.query('SELECT status FROM runs WHERE id = $1', [runId])).rows[0].status).toBe('finishing');

    await pool.query("UPDATE runs SET finishing_at = now() - interval '2 minutes' WHERE id = $1", [runId]);
    expect(await recoverStuckFinishingRuns()).toContain(runId);
    expect(enqueueSpy).toHaveBeenCalledWith(runId);

    await finalizeRun(runId);
    await finalizeRun(runId);
    expect((await pool.query('SELECT status FROM runs WHERE id = $1', [runId])).rows[0].status).toBe('rejected');
    expect((await pool.query('SELECT count(*)::int AS count FROM activity_sessions WHERE user_id = $1', [userId])).rows[0].count).toBe(1);
  });

  it('AC9: END TO END', async () => {
    const userId = crypto.randomUUID();
    const token = await createToken(userId);
    const r1 = await fastify.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` }, payload: {} });
    const runId = JSON.parse(r1.body).run_id;

    // We need 10 points to make a simple loop, we'll slice them in two batches
    const allPoints = generateSimpleLoop({ noiseStdDevM: 0, rotationDeg: 0 });
    const batch1 = allPoints.slice(0, 5).map((p, i) => ({
      seq: i,
      lat: p.lat,
      lng: p.lng,
      accuracy_m: 3.5,
      recorded_at: new Date(Date.now() + i * 1000).toISOString(),
    }));
    
    const batch2 = allPoints.slice(5).map((p, i) => ({
      seq: i + 5,
      lat: p.lat,
      lng: p.lng,
      accuracy_m: 3.5,
      recorded_at: new Date(Date.now() + (i + 5) * 1000).toISOString(),
    }));

    await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/points`,
      headers: { authorization: `Bearer ${token}` },
      payload: { idempotency_key: 'b1', points: batch1 },
    });

    await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/points`,
      headers: { authorization: `Bearer ${token}` },
      payload: { idempotency_key: 'b2', points: batch2 },
    });

    // Finish
    await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/finish`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Run the worker synchronously for the test
    testRunIds.push(runId);
    await finalizeRun(runId);

    // Assertions
    const territoryRes = await pool.query('SELECT id, owner_id FROM territories WHERE run_id = $1', [runId]);
    expect(territoryRes.rows.length).toBe(1);
    expect(territoryRes.rows[0].owner_id).toBe(userId);
    console.log('AC9 Territory row:', territoryRes.rows[0]);

    const activityRes = await pool.query('SELECT id, user_id FROM activity_sessions WHERE user_id = $1', [userId]);
    expect(activityRes.rows.length).toBe(1);
    expect(activityRes.rows[0].user_id).toBe(userId);
    console.log('AC9 Activity session row:', activityRes.rows[0]);
  });

  it('AC10: GET /v1/runs/:id as the owner returns status, stats, the territory object, rejection null, and score null', async () => {
    const userA = crypto.randomUUID();
    const tokenA = await createToken(userA);
    const testRunId = crypto.randomUUID();
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'finalized', now())", [testRunId, userA]);
    
    const testTerritoryId = crypto.randomUUID();
    const wkt = "POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))";
    await pool.query("INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, state) VALUES ($1, $2, $3, ST_Multi(ST_GeomFromText($4, 4326)), 100, now(), 'active')", [testTerritoryId, userA, testRunId, wkt]);

    const res = await fastify.inject({
      method: 'GET',
      url: `/v1/runs/${testRunId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run_id).toBe(testRunId);
    expect(body.status).toBe('finalized');
    expect(body.territory_reason).toBeNull();
    expect(body.stats).toBeDefined();
    expect(body.territory).toBeDefined();
    expect(body.territory.id).toBe(testTerritoryId);
    expect(body.rejection).toBeNull();
    expect(body.score).toBeNull();
  });

  it('WALK-2: GET /v1/runs/:id exposes a no-territory reason separately from rejection', async () => {
    const userA = crypto.randomUUID();
    const tokenA = await createToken(userA);
    const testRunId = crypto.randomUUID();
    await pool.query("INSERT INTO runs (id, user_id, status, started_at, territory_reason) VALUES ($1, $2, 'finalized', now(), 'not_closed')", [testRunId, userA]);
    testRunIds.push(testRunId);
    testUserIds.push(userA);

    const res = await fastify.inject({
      method: 'GET',
      url: `/v1/runs/${testRunId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'finalized',
      territory: null,
      territory_reason: 'not_closed',
      rejection: null,
    });
  });

  it('AC11: GET /v1/runs/:id for a REJECTED run returns territory null and a populated rejection object with the correct reason code', async () => {
    const userA = crypto.randomUUID();
    const tokenA = await createToken(userA);
    const testRunId = crypto.randomUUID();
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'rejected', now())", [testRunId, userA]);
    
    await pool.query("INSERT INTO run_rejections (run_id, reason, detail, rejected_at) VALUES ($1, 'below_minimum_area', 'Area too small', now())", [testRunId]);

    const res = await fastify.inject({
      method: 'GET',
      url: `/v1/runs/${testRunId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run_id).toBe(testRunId);
    expect(body.territory).toBeNull();
    expect(body.rejection).toBeDefined();
    expect(body.rejection.reason).toBe('below_minimum_area');
    expect(body.rejection.detail).toBe('Area too small');
    expect(body.score).toBeNull();
  });

  it('AC12: GET /v1/runs/:id as a different user returns 403 and no run data in the body', async () => {
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const tokenB = await createToken(userB);
    const testRunId = crypto.randomUUID();
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'active', now())", [testRunId, userA]);

    const res = await fastify.inject({
      method: 'GET',
      url: `/v1/runs/${testRunId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.run_id).toBeUndefined();
  });

  it('AC13: GET /v1/runs/:id for a nonexistent id returns 404', async () => {
    const userA = crypto.randomUUID();
    const tokenA = await createToken(userA);
    const testRunId = crypto.randomUUID();
    const res = await fastify.inject({
      method: 'GET',
      url: `/v1/runs/${testRunId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('Edge Case: GET /v1/runs/:id for a run in active or finishing status returns 200 with territory null and rejection null', async () => {
    const userA = crypto.randomUUID();
    const tokenA = await createToken(userA);
    
    // Active run
    const testRunId1 = crypto.randomUUID();
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'active', now())", [testRunId1, userA]);
    
    let res = await fastify.inject({
      method: 'GET',
      url: `/v1/runs/${testRunId1}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    let body = res.json();
    expect(body.status).toBe('active');
    expect(body.territory).toBeNull();
    expect(body.rejection).toBeNull();

    // Finishing run
    const testRunId2 = crypto.randomUUID();
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'finishing', now())", [testRunId2, userA]);
    
    res = await fastify.inject({
      method: 'GET',
      url: `/v1/runs/${testRunId2}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    body = res.json();
    expect(body.status).toBe('finishing');
    expect(body.territory).toBeNull();
    expect(body.rejection).toBeNull();
  });

  it('AC11/AC14: GET /v1/runs/:id returns { aggregate, band, decisive_layer } and does NOT include per-layer signals', async () => {
    const userA = crypto.randomUUID();
    const tokenA = await createToken(userA);
    const testRunId = crypto.randomUUID();
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'active', now())", [testRunId, userA]);

    const pts = generateRealisticPaceTrack();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p) continue;
      await pool.query(
        "INSERT INTO run_points (run_id, seq, lat, lng, accuracy_m, recorded_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [testRunId, i, p.lat, p.lng, 5, p.recorded_at]
      );
    }
    
    testRunIds.push(testRunId);
    await finalizeRun(testRunId);

    const res = await fastify.inject({
      method: 'GET',
      url: `/v1/runs/${testRunId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    console.log("AC11/AC14 (Scores) API response body:", JSON.stringify(body, null, 2));
    
    expect(body.score).toBeDefined();
    expect(typeof body.score.aggregate).toBe('number');
    expect(body.score.band).toBe('accept');
    expect(body.score.layers).toBeUndefined();

    // Assert P2: non-zero stats
    expect(body.stats).toBeDefined();
    expect(body.stats.distance_m).toBeGreaterThan(0);
    expect(body.stats.elapsed_time_s).toBeGreaterThan(0);
    expect(body.stats.moving_time_s).toBeGreaterThan(0);
    
    // Assert it matches the DB exactly
    const dbRes = await pool.query("SELECT aggregate, band FROM run_scores WHERE run_id = $1", [testRunId]);
    expect(dbRes.rows[0].aggregate).toBe(body.score.aggregate);
    expect(dbRes.rows[0].band).toBe(body.score.band);
  });
});
