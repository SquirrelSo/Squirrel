import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, HAS_DB, sql, useTestApp } from './setup.js';
import { assertNoCoordinates, fakeSocial } from './fake-social.js';
import { invalidateUserCache } from '../../src/users/repo.js';
import { resetIdentityState } from '../../src/identity/index.js';
import { xyToLatLng } from '../helpers.js';

async function openUser(id: string, until = "now() + interval '12 hours'") {
  await api('GET', '/v1/me', id);
  await sql(`UPDATE users SET open_to_meet = true, open_to_meet_until = ${until} WHERE id = $1`, [id]);
  invalidateUserCache(id);
}
async function present(id: string, x: number, y: number, activity: 'run' | 'walk' | null = null) {
  expect((await api('PUT', '/v1/map/presence', id, xyToLatLng(x, y))).status).toBe(200);
  if (activity) await sql(`UPDATE presence SET activity_type = $2, activity_started_at = now() WHERE user_id = $1`, [id, activity]);
}
const people = (r: { body: Record<string, any> }) => (r.body.items as any[]).map((i) => i.person.user_id);
const future = () => new Date(Date.now() + 3600_000).toISOString();

/** A verified visit to a zone, as qualification produces it. */
async function visit(userId: string, zoneId: string) {
  await api('GET', '/v1/me', userId);
  const act = randomUUID();
  await sql(`INSERT INTO activities (id, user_id, activity_type, verification_status, started_at) VALUES ($1, $2, 'walk', 'VERIFIED', now() - interval '1 day')`, [act, userId]);
  await sql(`INSERT INTO qualification_results (activity_id, user_id, zone_id, status, verified, interaction, evaluated_at) VALUES ($1, $2, $3, 'NOT_QUALIFIED', true, 'visited', now() - interval '1 day')`, [act, userId, zoneId]);
}

async function walkAll(url: string, user: string, limit: number) {
  const seen: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const r: any = await api('GET', `${url}${url.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`, user);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(limit);
    seen.push(...r.body.items);
    cursor = r.body.next_cursor;
    if (!cursor) break;
  }
  return seen;
}

describe.skipIf(!HAS_DB)('discover (integration)', () => {
  useTestApp();
  const social = fakeSocial();
  beforeAll(() => social.start());
  afterAll(() => social.stop());
  afterEach(() => { social.off(); social.reset(); });

  it('invalid queries are 422', async () => {
    await api('GET', '/v1/me', 'u_dv_bad');
    for (const url of ['/v1/discover?x=1', '/v1/discover/nearby?sort=distance', '/v1/discover/nearby?limit=51', '/v1/discover/active?sort=xp',
      '/v1/discover/active?activity_type=swim', '/v1/discover/challenges?type=duel', '/v1/discover/zones?sort=near', '/v1/discover/crews?cursor=%%%',
      '/v1/discover/crews?limit=0', '/v1/discover/zones?lat=1']) {
      expect((await api('GET', url, 'u_dv_bad')).status, url).toBe(422);
    }
  });

  describe('people', () => {
    beforeAll(async () => {
      await openUser('u_dp_me');
      await present('u_dp_me', 0, 0);
      await openUser('u_dp_close'); await present('u_dp_close', 60, 40, 'run');     // very close, running
      await openUser('u_dp_mid'); await present('u_dp_mid', 300, 200, 'walk');      // nearby, walking
      await openUser('u_dp_far'); await present('u_dp_far', 2000, 0, 'run');        // beyond 800 m: active, not nearby
      await openUser('u_dp_still'); await present('u_dp_still', 100, 0);           // nearby, no activity
      await openUser('u_dp_lapsed', "now() - interval '1 minute'"); await present('u_dp_lapsed', 50, 50, 'run');
      await api('GET', '/v1/me', 'u_dp_never'); await present('u_dp_never', 40, 40, 'run'); // never opted in
      await openUser('u_dp_blocked'); await present('u_dp_blocked', 30, 30, 'run');
      await api('POST', '/v1/users/u_dp_me/block', 'u_dp_blocked');
      await sql(`UPDATE users SET xp_total = 9000, xp_synced_at = now() WHERE id = 'u_dp_far'`);
      await sql(`UPDATE users SET xp_total = 100, xp_synced_at = now() WHERE id IN ('u_dp_close', 'u_dp_mid')`);
    });

    it('nearby: opted-in people around me, closest first, never coordinates, consent and blocks applied', async () => {
      const r = await api('GET', '/v1/discover/nearby', 'u_dp_me');
      expect(r.status).toBe(200);
      assertNoCoordinates(r.body);
      // very_close (≤150 m) before nearby; lapsed consent, never opted in, blocked and >800 m are absent
      expect(people(r).slice(0, 2).sort()).toEqual(['u_dp_close', 'u_dp_still']);
      expect(people(r)).toHaveLength(3);
      expect(people(r)[2]).toBe('u_dp_mid');
      expect((r.body.items as any[])[2].proximity).toBe('nearby');
      const close = (r.body.items as any[]).find((i) => i.person.user_id === 'u_dp_close');
      expect(close).toMatchObject({ proximity: 'very_close', activity: { type: 'run' }, states: expect.arrayContaining(['nearby', 'active_nearby', 'same_campus']) });
      expect(r.body.hidden_reason).toBeNull();
      expect(people(await api('GET', '/v1/discover/nearby?activity_type=walk', 'u_dp_me'))).toEqual(['u_dp_mid']);
      const recent = people(await api('GET', '/v1/discover/nearby?sort=recent', 'u_dp_me'));
      expect(recent.sort()).toEqual(['u_dp_close', 'u_dp_mid', 'u_dp_still']);
    });

    it('nearby: needs my own Open to Meet and a location', async () => {
      await api('GET', '/v1/me', 'u_dp_closed');
      expect((await api('GET', '/v1/discover/nearby', 'u_dp_closed')).body).toMatchObject({ items: [], hidden_reason: 'open_to_meet_off' });
      await openUser('u_dp_nowhere');
      expect((await api('GET', '/v1/discover/nearby', 'u_dp_nowhere')).body).toMatchObject({ items: [], hidden_reason: 'location_unknown' });
    });

    it('nearby: bubble members are included and merged with presence (zone filter)', async () => {
      await openUser('u_dp_bub');
      expect((await api('POST', '/v1/bubble/join', 'u_dp_bub', xyToLatLng(280, 110))).status).toBe(200); // library, no presence
      expect((await api('POST', '/v1/bubble/join', 'u_dp_me', xyToLatLng(10, 10))).status).toBe(200);
      const r = await api('GET', '/v1/discover/nearby', 'u_dp_me');
      expect(people(r)).toContain('u_dp_bub');
      expect(people(r)).not.toContain('u_dp_blocked');
      expect(people(await api('GET', '/v1/discover/nearby?zone_id=library', 'u_dp_me'))).toEqual(['u_dp_bub']);
      assertNoCoordinates(r.body);
      // A user appearing through both sources is listed once
      expect(new Set(people(r)).size).toBe(people(r).length);
    });

    it('nearby: keyset pagination visits each person exactly once', async () => {
      const all = people(await api('GET', '/v1/discover/nearby?limit=50', 'u_dp_me'));
      const walked = (await walkAll('/v1/discover/nearby', 'u_dp_me', 2)).map((i) => i.person.user_id);
      expect(walked).toEqual(all);
    });

    it('active: people with a live activity who opted in; sort by level; filters; pagination', async () => {
      const r = await api('GET', '/v1/discover/active', 'u_dp_me');
      expect(r.status).toBe(200);
      assertNoCoordinates(r.body);
      expect(people(r).sort()).toEqual(['u_dp_close', 'u_dp_far', 'u_dp_mid']);
      const byLevel = people(await api('GET', '/v1/discover/active?sort=level', 'u_dp_me'));
      expect(byLevel[0]).toBe('u_dp_far');
      expect(people(await api('GET', '/v1/discover/active?activity_type=walk', 'u_dp_me'))).toEqual(['u_dp_mid']);
      const walked = (await walkAll('/v1/discover/active?sort=level', 'u_dp_me', 1)).map((i) => i.person.user_id);
      expect(walked).toEqual(byLevel);
      // proximity only when I am open to meet
      expect((r.body.items as any[]).find((i) => i.person.user_id === 'u_dp_far').proximity).toBe('on_campus');
      await api('GET', '/v1/me', 'u_dp_shy');
      const shy = await api('GET', '/v1/discover/active', 'u_dp_shy');
      expect((shy.body.items as any[]).every((i) => i.proximity === null)).toBe(true);
    });

    it('Social unreachable: people sections fail closed with blocks_unreachable', async () => {
      social.on();
      social.state.mode = 'error';
      for (const url of ['/v1/discover/nearby', '/v1/discover/active']) {
        const r = await api('GET', url, 'u_dp_me');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ items: [], hidden_reason: 'blocks_unreachable' });
      }
      const all = await api('GET', '/v1/discover', 'u_dp_me');
      expect(all.status).toBe(200);
      expect(all.body.nearby).toEqual([]);
      expect(all.body.active).toEqual([]);
      expect(all.body.challenges).toEqual([]);
      expect(all.body.reasons).toMatchObject({ nearby: 'blocks_unreachable', active: 'blocks_unreachable', challenges: 'blocks_unreachable' });
      expect(all.body.zones).toEqual(expect.any(Array)); // independent sections still answer
    });
  });

  describe('territory battles', () => {
    it('only battles I am part of; blocked creators hidden; filters; relation and flags', async () => {
      for (const u of ['u_dc_a', 'u_dc_b', 'u_dc_c', 'u_dc_d', 'u_dc_x']) await api('GET', '/v1/me', u);
      const mk = async (from: string, to: string, zone: string, type = 'territory') => {
        const r = await api('POST', '/v1/challenges', from, { type, target: { type: 'user', id: to }, zone_id: zone, starts_at: future(), message: `secret ${from}->${to}` });
        expect(r.status).toBe(201);
        return r.body.id as string;
      };
      const mine = await mk('u_dc_a', 'u_dc_b', 'library');
      const incoming = await mk('u_dc_c', 'u_dc_a', 'cc1', 'zone_race');
      const privateOther = await mk('u_dc_c', 'u_dc_d', 'library');
      const fromBlocked = await mk('u_dc_x', 'u_dc_a', 'mess');
      await api('POST', '/v1/users/u_dc_x/block', 'u_dc_a');
      const act = randomUUID();
      await sql(`INSERT INTO activities (id, user_id, activity_type, verification_status, started_at) VALUES ($1, 'u_dc_a', 'run', 'VERIFIED', now())`, [act]);
      await sql(`INSERT INTO qualification_results (activity_id, user_id, zone_id, status, verified, interaction, expires_at) VALUES ($1, 'u_dc_a', 'cc1', 'QUALIFIED', true, 'visited', now() + interval '1 hour')`, [act]);

      const r = await api('GET', '/v1/discover/challenges', 'u_dc_a');
      expect(r.status).toBe(200);
      const got = r.body.items as any[];
      expect(got.map((c) => c.id).sort()).toEqual([mine, incoming].sort());
      expect(got.map((c) => c.id)).not.toContain(privateOther);
      expect(got.map((c) => c.id)).not.toContain(fromBlocked);
      expect(got[0]).toMatchObject({ id: incoming, relation: 'incoming', zone_qualified: true, actions: expect.arrayContaining(['accept']) }); // qualified zone first
      expect(got.find((c) => c.id === mine)).toMatchObject({ relation: 'yours', zone_qualified: false });
      expect(JSON.stringify(r.body)).not.toContain('secret u_dc_c->u_dc_d');

      expect((await api('GET', '/v1/discover/challenges?type=zone_race', 'u_dc_a')).body.items.map((c: any) => c.id)).toEqual([incoming]);
      expect((await api('GET', '/v1/discover/challenges?zone_id=library', 'u_dc_a')).body.items.map((c: any) => c.id)).toEqual([mine]);
      const walked = (await walkAll('/v1/discover/challenges', 'u_dc_a', 1)).map((c) => c.id);
      expect(walked).toEqual(got.map((c) => c.id));
      // the third party sees only their own
      expect((await api('GET', '/v1/discover/challenges', 'u_dc_d')).body.items.map((c: any) => c.id)).toEqual([privateOther]);
    });
  });

  describe('crews and zones', () => {
    const crewA = randomUUID(), crewB = randomUUID();
    beforeAll(async () => {
      await api('GET', '/v1/me', 'u_dz_owner');
      const hold = async (zone: string, crew: string) => sql(
        `UPDATE territories SET owner_id = 'u_dz_owner', owner_type = 'CREW', crew_id = $2, status = 'CLAIMED', claimed_at = now() WHERE zone_id = $1`, [zone, crew]);
      await hold('mess', crewA); await hold('gate', crewA); await hold('lake', crewA);
      await hold('admin', crewB);
      await sql(`UPDATE territories SET under_challenge = true WHERE zone_id = 'amphi'`);
      // popularity: library 3 distinct verified visitors (shown), research only 2 (suppressed)
      for (const u of ['u_dz_v1', 'u_dz_v2', 'u_dz_v3']) await visit(u, 'library');
      for (const u of ['u_dz_v1', 'u_dz_v2']) await visit(u, 'research');
    });

    it('crews ranked by zones held, names from Social, no member lists', async () => {
      social.on();
      const member = { subject: 'u_dz_owner', role: 'owner', joined_at: new Date().toISOString() };
      social.state.crews.set(crewA, { id: crewA, name: 'Night Owls', interest: 'running', members: [member] });
      social.state.crews.set(crewB, { id: crewB, name: 'Lake Walkers', interest: 'walking', members: [member] });
      const r = await api('GET', '/v1/discover/crews', 'u_dz_owner');
      expect(r.status).toBe(200);
      expect(r.body.items).toEqual([
        { crew: { id: crewA, name: 'Night Owls', color: null, icon: 'run' }, zones_held: 3 },
        { crew: { id: crewB, name: 'Lake Walkers', color: null, icon: 'walk' }, zones_held: 1 },
      ]);
      expect(JSON.stringify(r.body)).not.toContain('members');
      expect(JSON.stringify(r.body)).not.toContain('u_dz_owner');
      const p1 = await api('GET', '/v1/discover/crews?limit=1', 'u_dz_owner');
      expect(p1.body.items).toHaveLength(1);
      const p2 = await api('GET', `/v1/discover/crews?limit=1&cursor=${p1.body.next_cursor}`, 'u_dz_owner');
      expect(p2.body.items[0].crew.id).toBe(crewB);
      expect(p2.body.next_cursor).toBeNull();
    });

    it('crews while Social is down: ids without names and a reason', async () => {
      social.on();
      social.state.mode = 'error';
      resetIdentityState();
      const r = await api('GET', '/v1/discover/crews', 'u_dz_owner');
      expect(r.status).toBe(200);
      expect(r.body.hidden_reason).toBe('crew_names_unavailable');
      expect(r.body.items.map((i: any) => i.crew.id)).toEqual([crewA, crewB]);
    });

    it('zones: popularity is k-anonymous (≥3 distinct users) and only a bucket', async () => {
      const r = await api('GET', '/v1/discover/zones', 'u_dz_owner');
      expect(r.status).toBe(200);
      assertNoCoordinates(r.body);
      const ids = (r.body.items as any[]).map((z) => z.zone.id);
      expect(ids).toContain('library');
      expect(ids).not.toContain('research');
      expect((r.body.items as any[]).find((z) => z.zone.id === 'library').popularity).toBe('low');
      const text = JSON.stringify(r.body);
      expect(text).not.toMatch(/"(users|user_count|count|visitors|user_id|owner)"/);
      // the cursor carries no exact count either
      const p = await api('GET', '/v1/discover/zones?limit=1', 'u_dz_owner');
      if (p.body.next_cursor) expect(Buffer.from(String(p.body.next_cursor), 'base64url').toString()).not.toMatch(/\b3\b/);
    });

    it('zones: contested and unclaimed views, paginated', async () => {
      const contested = await api('GET', '/v1/discover/zones?sort=contested', 'u_dz_owner');
      expect((contested.body.items as any[]).map((z) => z.zone.id)).toEqual(['amphi']);
      const unclaimed = await walkAll('/v1/discover/zones?sort=unclaimed', 'u_dz_owner', 3);
      const unclaimedIds = unclaimed.map((z) => z.zone.id);
      expect(unclaimedIds).not.toContain('mess');
      expect(unclaimedIds).toContain('library');
      expect(new Set(unclaimedIds).size).toBe(unclaimedIds.length);
      expect(unclaimed.every((z) => z.territory.status === 'unclaimed')).toBe(true);
    });

    it('the summary has every section, five at most each, and an as_of', async () => {
      const r = await api('GET', '/v1/discover', 'u_dz_owner');
      expect(r.status).toBe(200);
      for (const k of ['nearby', 'active', 'challenges', 'zones', 'crews']) {
        expect(Array.isArray(r.body[k])).toBe(true);
        expect((r.body[k] as unknown[]).length).toBeLessThanOrEqual(5);
      }
      expect(r.body.reasons).toMatchObject({ nearby: 'open_to_meet_off' });
      expect(typeof r.body.as_of).toBe('string');
      expect((r.body.zones as any[]).map((z) => z.zone.id)).toContain('library');
      assertNoCoordinates(r.body);
    });
  });
});
