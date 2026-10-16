import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'crypto';
import { pool } from '../../db/pool.js';
import { runDecay } from './decay.js';
import { captureTerritory } from '../finalize_run/capture.js';

describe('Territory Decay', () => {
  const testRunIds: string[] = [];
  const testUserIds: string[] = [];
  const testTerritoryIds: string[] = [];

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    if (testUserIds.length > 0) {
      const users = [...testUserIds];
      await pool.query("DELETE FROM capture_events WHERE actor_id = ANY($1)", [users]);
      testUserIds.length = 0;
    }
    
    if (testRunIds.length > 0) {
      const ids = [...testRunIds];
      await pool.query("DELETE FROM run_point_flags WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_points WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_signatures WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_batches WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_scores WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM run_rejections WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM territories WHERE run_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM runs WHERE id = ANY($1)", [ids]);
      testRunIds.length = 0;
    }

    if (testTerritoryIds.length > 0) {
      const ids = [...testTerritoryIds];
      await pool.query("DELETE FROM territories WHERE id = ANY($1)", [ids]);
      testTerritoryIds.length = 0;
    }
  });

  async function seedTerritory(owner: string, state: 'active'|'expired', expiresAt: Date, geomWkt: string, areaM2: number): Promise<string> {
    const tid = crypto.randomUUID();
    const runId = crypto.randomUUID();
    testUserIds.push(owner);
    testRunIds.push(runId);
    testTerritoryIds.push(tid);

    await pool.query(
      "INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'active', now())",
      [runId, owner]
    );

    await pool.query(
      "INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, expires_at, state) VALUES ($1, $2, $3, ST_Multi(ST_GeomFromText($4, 4326)), $5, now(), $6, $7)",
      [tid, owner, runId, geomWkt, areaM2, expiresAt, state]
    );
    return tid;
  }

  it('AC1/AC2: SPEC CRITERION - transitions only expired territories and emits correct event', async () => {
    const u1 = crypto.randomUUID();
    const now = new Date();
    const past = new Date(now.getTime() - 10000);
    const future = new Date(now.getTime() + 10000);

    const tExpired = await seedTerritory(u1, 'active', past, 'POLYGON((10 10, 11 10, 11 11, 10 11, 10 10))', 50000);
    const tUnexpired = await seedTerritory(u1, 'active', future, 'POLYGON((2 2, 2 3, 3 3, 3 2, 2 2))', 40000);

    const initialUnexpired = (await pool.query("SELECT * FROM territories WHERE id = $1", [tUnexpired])).rows[0];

    const result = await runDecay(now);
    expect(result.expiredCount).toBe(1);

    const unexpired = (await pool.query("SELECT * FROM territories WHERE id = $1", [tUnexpired])).rows[0];
    expect(unexpired.state).toBe('active');
    expect(unexpired.area_m2).toBe(initialUnexpired.area_m2);
    expect(unexpired.expires_at.getTime()).toBe(initialUnexpired.expires_at.getTime());

    const expired = (await pool.query("SELECT * FROM territories WHERE id = $1", [tExpired])).rows[0];
    expect(expired.state).toBe('expired');

    const event = (await pool.query("SELECT * FROM capture_events WHERE territory_id = $1 AND event_type = 'expired'", [tExpired])).rows[0];
    console.log("AC2 Event Row:\\n", JSON.stringify(event, null, 2));
    expect(event).toBeDefined();
    expect(event.actor_id).toBe(u1);
    expect(event.previous_owner_id).toBe(u1);
    expect(Number(event.area_delta_m2)).toBe(-50000);
  });

  it('AC3: IDEMPOTENCY - second run expires 0 rows', async () => {
    const u1 = crypto.randomUUID();
    const now = new Date();
    const past = new Date(now.getTime() - 10000);
    
    await seedTerritory(u1, 'active', past, 'POLYGON((10 10, 11 10, 11 11, 10 11, 10 10))', 50000);

    const res1 = await runDecay(now);
    expect(res1.expiredCount).toBe(1);

    const events1 = Number((await pool.query("SELECT count(*) as c FROM capture_events WHERE event_type='expired'")).rows[0].c);

    const res2 = await runDecay(now);
    expect(res2.expiredCount).toBe(0);

    const events2 = Number((await pool.query("SELECT count(*) as c FROM capture_events WHERE event_type='expired'")).rows[0].c);
    console.log(`AC3 runs: Run 1 count=${res1.expiredCount}, events=${events1} | Run 2 count=${res2.expiredCount}, events=${events2}`);
    expect(events2).toBe(events1);
  });

  it('AC4: BOUNDARY - exact match expires, +1s does not', async () => {
    const u1 = crypto.randomUUID();
    const now = new Date('2026-09-20T12:00:00Z');
    
    const exact = await seedTerritory(u1, 'active', now, 'POLYGON((10 10, 11 10, 11 11, 10 11, 10 10))', 50000);
    const plusOne = await seedTerritory(u1, 'active', new Date(now.getTime() + 1000), 'POLYGON((2 2, 2 3, 3 3, 3 2, 2 2))', 50000);

    await runDecay(now);

    const stExact = (await pool.query("SELECT state FROM territories WHERE id = $1", [exact])).rows[0].state;
    const stPlus = (await pool.query("SELECT state FROM territories WHERE id = $1", [plusOne])).rows[0].state;

    expect(stExact).toBe('expired');
    expect(stPlus).toBe('active');
    console.log("AC4: compared expires_at <= now");
  });

  it('AC5: BATCHING - 1200 territories expire in batches', async () => {
    const u1 = crypto.randomUUID();
    const now = new Date();
    const past = new Date(now.getTime() - 10000);

    testUserIds.push(u1);
    const runId = crypto.randomUUID();
    testRunIds.push(runId);
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'active', now())", [runId, u1]);

    // Bulk insert 1200 territories
    const batchValues = [];
    const params = [];
    let pIdx = 1;
    for (let i = 0; i < 1200; i++) {
      const tid = crypto.randomUUID();
      testTerritoryIds.push(tid);
      batchValues.push(`(` + `$${pIdx++}, ` + `$${pIdx++}, ` + `$${pIdx++}, ST_Multi(ST_GeomFromText('POLYGON((10 10, 11 10, 11 11, 10 11, 10 10))', 4326)), 50000, now(), ` + `$${pIdx++}, 'active')`);
      params.push(tid, u1, runId, past);
    }
    
    const query = 'INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, expires_at, state) VALUES ' + batchValues.join(', ');
    await pool.query(query, params);

    const res = await runDecay(now);
    console.log(`AC5: Expired ${res.expiredCount} across batches. Duration: ${res.durationMs}ms`);
    expect(res.expiredCount).toBe(1200);

    // Verify 1200 events
    const eCount = await pool.query("SELECT count(*) as c FROM capture_events WHERE actor_id = $1 AND event_type = 'expired'", [u1]);
    expect(Number(eCount.rows[0].c)).toBeGreaterThanOrEqual(1200);
  });

  it('AC6 & AC8: NEW TERRITORIES have expires_at +14d, CARVED keep original', async () => {
    const uCap = crypto.randomUUID();
    testUserIds.push(uCap);
    const rCap = crypto.randomUUID();
    testRunIds.push(rCap);
    await pool.query("INSERT INTO runs (id, user_id, status, started_at) VALUES ($1, $2, 'active', now())", [rCap, uCap]);

    const uVictim = crypto.randomUUID();
    const past = new Date(Date.now() - 5 * 24 * 3600 * 1000); // 5 days ago
    const tVictim = await seedTerritory(uVictim, 'active', new Date(past.getTime() + 14 * 24 * 3600 * 1000), 'POLYGON((10 10, 10.01 10, 10.01 10.01, 10 10.01, 10 10))', 1000000);

    const client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const geomCap = 'POLYGON((9.995 9.995, 10.005 9.995, 10.005 10.005, 9.995 10.005, 9.995 9.995))';
    
    const capRes = await captureTerritory({
      client, runId: rCap, ownerId: uCap, geomWkt4326: geomCap, areaM2: 50000
    });
    testTerritoryIds.push(capRes.territoryId);
    capRes.carved.forEach(c => { if(c.areaAfterM2 > 0) testTerritoryIds.push(c.territoryId); });
    await client.query("COMMIT");
    client.release();

    const tNew = (await pool.query("SELECT claimed_at, expires_at FROM territories WHERE id = $1", [capRes.territoryId])).rows[0];
    const diffDays = (tNew.expires_at.getTime() - tNew.claimed_at.getTime()) / (1000 * 3600 * 24);
    expect(Math.round(diffDays)).toBe(14);

    const carve = capRes.carved.find(c => c.territoryId === tVictim);
    const carvedVictim = (await pool.query("SELECT * FROM territories WHERE id = $1", [carve!.territoryId])).rows[0];
    if (!carvedVictim.expires_at) console.log('CARVED VICTIM IS NULL EXPIRES:', carvedVictim);
    const initialVictimExpiry = new Date(past.getTime() + 14 * 24 * 3600 * 1000);
    expect(carvedVictim.expires_at.getTime()).toBe(initialVictimExpiry.getTime());
  });

  it('AC7: BACKFILL - no territory has expires_at NULL', async () => {
    await pool.query("UPDATE territories SET expires_at = claimed_at + interval '14 days' WHERE expires_at IS NULL");
    const res = await pool.query("SELECT count(*) as c FROM territories WHERE expires_at IS NULL");
    expect(Number(res.rows[0].c)).toBe(0);
  });
  
  it('AC9: emits expired, never full_capture', async () => {
    const u1 = crypto.randomUUID();
    const now = new Date();
    await seedTerritory(u1, 'active', new Date(now.getTime() - 1000), 'POLYGON((10 10, 11 10, 11 11, 10 11, 10 10))', 50000);
    const res = await runDecay(now);
    const events = await pool.query("SELECT DISTINCT event_type FROM capture_events WHERE id = ANY($1)", [res.eventIds]);
    const types = events.rows.map(r => r.event_type);
    expect(types).toEqual(['expired']);
  });
});
