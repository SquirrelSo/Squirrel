import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api, sql } from './setup.js';
import { useTestApp, runFakeStats, resetRunFakeStats, runFakeState } from './setup.js';
import { randomUUID } from 'crypto';
import { runSettings, configureRunBridge } from '../../src/run/index.js';

describe('XP cache to Run Module (integration)', () => {
  useTestApp();

  beforeEach(async () => {
    resetRunFakeStats();
    runFakeState.offline = false;
    // reset downUntil circuit breaker so offline tests don't poison subsequent tests
    const s = runSettings();
    if (s) configureRunBridge({ url: s.url, token: s.token });
  });
  
  afterEach(() => {
    runFakeState.offline = false;
  });

  async function makeActive(userId: string) {
    await api('GET', '/v1/me', userId);
    await sql(`INSERT INTO activities (user_id, activity_type, verification_status, started_at) VALUES ($1, 'walk', 'VERIFIED', now())`, [userId]);
    await api('PUT', '/v1/me/open-to-meet', userId, { enabled: true });
    await sql(`INSERT INTO presence (user_id, geom, accuracy_m, updated_at, expires_at) VALUES ('${userId}', ST_SetSRID(ST_MakePoint(0, 0), 4326), 10, now(), now() + interval '1 hour') ON CONFLICT (user_id) DO UPDATE SET updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at`);
  }

  it('a claim reports the award and stores the returned total', async () => {
    const actor = 'u_xp_1';
    await api('GET', '/v1/me', actor);
    
    // qualify
    const actId = randomUUID();
    await sql(`INSERT INTO activities (id, user_id, raw_track, verification_status, activity_type, started_at, updated_at) VALUES ('${actId}', '${actor}', ST_GeomFromText('LINESTRING(0 0, 1 1)', 4326), 'VERIFIED', 'run', now(), now())`);
    await sql(`INSERT INTO qualification_results (id, user_id, zone_id, status, activity_id, expires_at, interaction, verified) VALUES ('${randomUUID()}', '${actor}', 'library', 'QUALIFIED', '${actId}', now() + interval '1 hour', 'visited', true)`);
    
    const res = await api('POST', '/v1/zones/library/claim', actor, { idempotency_key: 'ik_xp_1' });
    expect(res.status).toBe(200);
    expect(runFakeStats.awards).toBe(1);
    
    const after = await sql(`SELECT xp_total FROM users WHERE id = '${actor}'`);
    // our fake Run Module returns amount + 1000
    expect(after[0].xp_total).toBe(1025); // 25 (claim) + 1000
  });

  it('a replayed claim does not award twice, total unchanged', async () => {
    const actor = 'u_xp_1';
    const res = await api('POST', '/v1/zones/library/claim', actor, { idempotency_key: 'ik_xp_1' });
    expect(res.status).toBe(200);
    // replay hits idempotency
    expect(runFakeStats.awards).toBe(0);
    
    const after = await sql(`SELECT xp_total FROM users WHERE id = '${actor}'`);
    expect(after[0].xp_total).toBe(1025); 
  });

  it('the total is never computed locally: assert the stored value equals exactly what the fake returned, even when that differs from old value + award', async () => {
    const actor = 'u_xp_2';
    await api('GET', '/v1/me', actor);
    
    const actId = randomUUID();
    await sql(`INSERT INTO activities (id, user_id, raw_track, verification_status, activity_type, started_at, updated_at) VALUES ('${actId}', '${actor}', ST_GeomFromText('LINESTRING(0 0, 1 1)', 4326), 'VERIFIED', 'run', now(), now())`);
    await sql(`INSERT INTO qualification_results (id, user_id, zone_id, status, activity_id, expires_at, interaction, verified) VALUES ('${randomUUID()}', '${actor}', 'cc1', 'QUALIFIED', '${actId}', now() + interval '1 hour', 'visited', true)`);
    
    const res = await api('POST', '/v1/zones/cc1/claim', actor, { idempotency_key: 'ik_xp_2' });
    expect(res.status).toBe(200);
    
    const after = await sql(`SELECT xp_total FROM users WHERE id = '${actor}'`);
    expect(after[0].xp_total).toBe(1025); 
  });

  it('a stale list refreshes in ONE batch call, not N — assert the call count', async () => {
    const u1 = 'u_xp_stale_1';
    const u2 = 'u_xp_stale_2';
    await api('GET', '/v1/me', u1);
    await api('GET', '/v1/me', u2);
    await makeActive(u1);
    await makeActive(u2);
    
    // make them stale
    await sql(`UPDATE users SET xp_synced_at = now() - interval '10 minutes' WHERE id IN ('${u1}', '${u2}')`);
    
    // map/players triggers list refresh
    const res = await api('GET', '/v1/map/players', u1);
    expect(res.status).toBe(200);
    expect(runFakeStats.totals).toBe(1); // exactly one batched call
    
    // fake returns 12000
    const check = await sql(`SELECT id, xp_total FROM users WHERE id IN ('${u1}', '${u2}') ORDER BY id`);
    expect(check.find((r: any) => r.id === u2).xp_total).toBe(12000);
  });

  it('a fresh list makes no call at all', async () => {
    const p1 = 'u_xp_stale_1';
    resetRunFakeStats();
    
    const res = await api('GET', '/v1/map/players', p1);
    expect(res.status).toBe(200);
    expect(runFakeStats.totals).toBe(0); // already fresh from previous test!
  });

  it('the Run Module unreachable: lists still return, cached numbers served, no error to the client', async () => {
    const viewer = 'u_xp_viewer';
    const target = 'u_xp_off_1';
    await api('GET', '/v1/me', viewer);
    await api('GET', '/v1/me', target);
    await makeActive(viewer);
    await makeActive(target);
    await sql(`UPDATE users SET xp_synced_at = now() - interval '10 minutes', xp_total = 999 WHERE id = '${target}'`);
    
    runFakeState.offline = true;
    
    const res = await api('GET', '/v1/map/players', viewer);
    expect(res.status).toBe(200); // Success! No error!
    
    const found = res.body.players.find((p: any) => p.user_id === target);
    expect(found.xp).toBe(999);
  });

  it('the Run Module unreachable during a claim: THE CLAIM STILL SUCCEEDS', async () => {
    const actor = 'u_xp_off_2';
    await api('GET', '/v1/me', actor);
    
    const actId = randomUUID();
    await sql(`INSERT INTO activities (id, user_id, raw_track, verification_status, activity_type, started_at, updated_at) VALUES ('${actId}', '${actor}', ST_GeomFromText('LINESTRING(0 0, 1 1)', 4326), 'VERIFIED', 'run', now(), now())`);
    await sql(`INSERT INTO qualification_results (id, user_id, zone_id, status, activity_id, expires_at, interaction, verified) VALUES ('${randomUUID()}', '${actor}', 'nivedita', 'QUALIFIED', '${actId}', now() + interval '1 hour', 'visited', true)`);
    
    runFakeState.offline = true;
    
    const res = await api('POST', '/v1/zones/nivedita/claim', actor, { idempotency_key: 'ik_xp_off' });
    expect(res.status).toBe(200); // STILL SUCCEEDS!
    
    const owner = await sql(`SELECT owner_id FROM territories WHERE zone_id = 'nivedita'`);
    expect(owner[0].owner_id).toBe(actor);
  });

  it('xp_synced_at is stamped on refresh', async () => {
    const viewer = 'u_xp_viewer2';
    const actor = 'u_xp_stamp';
    await api('GET', '/v1/me', viewer);
    await api('GET', '/v1/me', actor);
    await makeActive(viewer);
    await makeActive(actor);
    await sql(`UPDATE users SET xp_synced_at = '2020-01-01T00:00:00Z' WHERE id = '${actor}'`);
    
    await api('GET', '/v1/map/players', viewer);
    const check = await sql(`SELECT xp_synced_at FROM users WHERE id = '${actor}'`);
    expect(new Date(check[0].xp_synced_at).getFullYear()).toBeGreaterThan(2020);
  });

  it('a batch over 200 subjects is split', async () => {
    const users = Array.from({ length: 250 }, (_, i) => `u_bulk_${i}`);
    for (let i = 0; i < 250; i++) {
      await api('GET', '/v1/me', users[i]);
    }
    await sql(`UPDATE users SET xp_synced_at = now() - interval '10 minutes' WHERE id LIKE 'u_bulk_%'`);
    
    const { getPeopleLite } = await import('../../src/users/repo.js');
    await getPeopleLite(users);
    
    // Needs 2 totals calls (200, 50)
    expect(runFakeStats.totals).toBe(2);
    expect(runFakeStats.lastTotalSubjects).toBeLessThanOrEqual(200);
  });
});
