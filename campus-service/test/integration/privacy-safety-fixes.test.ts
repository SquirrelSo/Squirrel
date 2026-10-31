/** Audit fixes: lapsed Open to Meet on map/nearby, presence sweep scheduling, blocks on territory battles. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, HAS_DB, sql, useTestApp } from './setup.js';
import { fakeSocial } from './fake-social.js';
import { invalidateUserCache } from '../../src/users/repo.js';
import { runSweeps, startSweeper } from '../../src/sweeper.js';
import { xyToLatLng } from '../helpers.js';

async function openUser(id: string, until = "now() + interval '12 hours'") {
  await api('GET', '/v1/me', id);
  await sql(`UPDATE users SET open_to_meet = true, open_to_meet_until = ${until} WHERE id = $1`, [id]);
  invalidateUserCache(id);
}
const here = xyToLatLng(0, 0), close = xyToLatLng(60, 40);
const future = () => new Date(Date.now() + 3600_000).toISOString();

describe.skipIf(!HAS_DB)('privacy and safety fixes (integration)', () => {
  useTestApp();
  const social = fakeSocial();
  beforeAll(() => social.start());
  afterAll(() => social.stop());
  afterEach(() => { social.off(); social.reset(); });

  describe('other people\'s lapsed Open to Meet', () => {
    it('map players and the nearby list leave out someone whose open_to_meet_until has passed', async () => {
      await openUser('u_pf_view');
      await openUser('u_pf_live');
      await openUser('u_pf_lapsed', "now() - interval '1 minute'"); // flag still true, window over
      for (const u of ['u_pf_view', 'u_pf_live', 'u_pf_lapsed']) expect((await api('PUT', '/v1/map/presence', u, u === 'u_pf_view' ? here : close)).status).toBe(200);
      await sql(`UPDATE presence SET activity_type = 'run', activity_started_at = now() WHERE user_id IN ('u_pf_live', 'u_pf_lapsed')`);

      const players = (await api('GET', '/v1/map/players', 'u_pf_view')).body.players as any[];
      expect(players.map((p) => p.user_id)).toContain('u_pf_live');
      expect(players.map((p) => p.user_id)).not.toContain('u_pf_lapsed');

      const nearby = (await api('GET', '/v1/activity/nearby', 'u_pf_view')).body.nearby as any[];
      expect(nearby.map((p) => p.person.user_id)).toContain('u_pf_live');
      expect(nearby.map((p) => p.person.user_id)).not.toContain('u_pf_lapsed');

      // In "active" (public activity) a lapsed person keeps no proximity bucket.
      const active = (await api('GET', '/v1/people/active', 'u_pf_view')).body.active as any[];
      expect(active.find((p) => p.person.user_id === 'u_pf_lapsed')?.proximity).toBeNull();
      expect(active.find((p) => p.person.user_id === 'u_pf_live')?.proximity).toBe('very_close');
    });
  });

  describe('presence sweep', () => {
    it('deletes expired exact fixes and keeps live ones', async () => {
      await openUser('u_sw_old');
      await openUser('u_sw_new');
      await api('PUT', '/v1/map/presence', 'u_sw_old', here);
      await api('PUT', '/v1/map/presence', 'u_sw_new', here);
      await sql(`UPDATE presence SET expires_at = now() - interval '1 second' WHERE user_id = 'u_sw_old'`);
      const r = await runSweeps();
      expect(r.presence).toBeGreaterThanOrEqual(1);
      expect(await sql(`SELECT user_id FROM presence WHERE user_id IN ('u_sw_old', 'u_sw_new') ORDER BY user_id`)).toEqual([{ user_id: 'u_sw_new' }]);
    });

    it('the scheduler runs the sweep on start and on its interval, and stops on abort', async () => {
      await api('PUT', '/v1/map/presence', 'u_sw_old', here);
      await sql(`UPDATE presence SET expires_at = now() - interval '1 second' WHERE user_id = 'u_sw_old'`);
      const abort = new AbortController();
      startSweeper({ warn: () => undefined }, abort.signal, 50);
      for (let i = 0; i < 50 && (await sql(`SELECT 1 FROM presence WHERE user_id = 'u_sw_old'`)).length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(await sql(`SELECT 1 FROM presence WHERE user_id = 'u_sw_old'`)).toEqual([]);
      // a later expiry is picked up by the interval, not just the first run
      await api('PUT', '/v1/map/presence', 'u_sw_old', here);
      await sql(`UPDATE presence SET expires_at = now() - interval '1 second' WHERE user_id = 'u_sw_old'`);
      for (let i = 0; i < 50 && (await sql(`SELECT 1 FROM presence WHERE user_id = 'u_sw_old'`)).length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(await sql(`SELECT 1 FROM presence WHERE user_id = 'u_sw_old'`)).toEqual([]);
      abort.abort();
    });
  });

  describe('territory battles and blocks', () => {
    const body = (target: string) => ({ type: 'territory', target: { type: 'user', id: target }, zone_id: 'library', starts_at: future() });

    it('creating a battle against someone blocked either way is refused as not found', async () => {
      for (const u of ['u_cb_a', 'u_cb_b', 'u_cb_c']) await api('GET', '/v1/me', u);
      await api('POST', '/v1/users/u_cb_a/block', 'u_cb_b'); // B blocked A
      const r = await api('POST', '/v1/challenges', 'u_cb_a', body('u_cb_b'));
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('not_found');
      const r2 = await api('POST', '/v1/challenge-invites', 'u_cb_b', body('u_cb_a'));
      expect(r2.status).toBe(404);
      expect((await sql(`SELECT 1 FROM challenges WHERE created_by IN ('u_cb_a','u_cb_b')`)).length).toBe(0);
      // unrelated people are unaffected
      expect((await api('POST', '/v1/challenges', 'u_cb_a', body('u_cb_c'))).status).toBe(201);
    });

    it('accepting a battle from someone blocked since is refused as not found, and nothing changes', async () => {
      for (const u of ['u_ca_a', 'u_ca_b']) await api('GET', '/v1/me', u);
      const created = await api('POST', '/v1/challenges', 'u_ca_a', body('u_ca_b'));
      expect(created.status).toBe(201);
      await api('POST', '/v1/users/u_ca_a/block', 'u_ca_b');
      const r = await api('POST', `/v1/challenges/${created.body.id}/accept`, 'u_ca_b');
      expect(r.status).toBe(404);
      expect((await sql(`SELECT status FROM challenges WHERE id = $1`, [created.body.id]))[0]!.status).toBe('pending');
      // declining stays possible (it is not contact)
      expect((await api('POST', `/v1/challenges/${created.body.id}/decline`, 'u_ca_b')).status).toBe(200);
    });

    it('blocks known only to Social count, and Social unreachable refuses with 503 blocks_unreachable', async () => {
      for (const u of ['u_cs_a', 'u_cs_b', 'u_cs_c']) await api('GET', '/v1/me', u);
      const pending = await api('POST', '/v1/challenges', 'u_cs_c', body('u_cs_a'));
      expect(pending.status).toBe(201);
      social.on();
      social.state.blocks.set('u_cs_b', ['u_cs_a']);
      expect((await api('POST', '/v1/challenges', 'u_cs_a', body('u_cs_b'))).status).toBe(404);
      social.state.mode = 'error';
      social.on(); // drop the 30 s block cache so the outage is seen
      const down = await api('POST', '/v1/challenges', 'u_cs_a', { ...body('u_cs_c'), zone_id: 'cc1' });
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('blocks_unreachable');
      const acc = await api('POST', `/v1/challenges/${pending.body.id}/accept`, 'u_cs_a');
      expect(acc.status).toBe(503);
      expect(acc.body.code).toBe('blocks_unreachable');
    });
  });
});
