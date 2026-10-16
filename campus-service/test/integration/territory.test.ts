import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { configureSocialBridge } from '../../src/identity/index.js';
import { HAS_DB, useTestApp, api, submitAndVerify, sql } from './setup.js';
import { trackAlong, sweepRect } from '../helpers.js';

// CC1 placeholder rectangle in local metres (see src/seed/zones.ts)
const CC1 = { x0: 70, y0: 40, x1: 195, y1: 150 };
// A loop that fully sweeps CC1 and adds distance outside it (≈1.4 km at 3.2 m/s ≈ 7 min)
const cc1Sweep = () => trackAlong([[-100, -100], [CC1.x0, CC1.y0 + 5], ...sweepRect(CC1.x0, CC1.y0, CC1.x1, CC1.y1, 20), [300, 300], [-100, -100]], 3.2);
// Passing through one corner of CC1 only
const cc1Corner = () => trackAlong([[-200, -200], [80, 50], [110, 50], [300, 300], [600, 300]], 3.2);
const key = () => `k-${Math.random().toString(36).slice(2)}`;
const forwarded: { user_subject: string; kind: string; actor_subject?: string; title: string; body?: string; data: Record<string, unknown>; dedupe_key: string }[] = [];
let socialServer: Server;
let socialUrl = '';

function startFakeSocial() {
  socialServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/internal/v1/people/resolve') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [] })); return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/internal/v1/blocks/')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ blocked: [] })); return;
      }
      if (req.method !== 'POST' || req.url !== '/internal/v1/notifications') { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw || '{}') as typeof forwarded[number];
      forwarded.push(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ created: true, notification_id: randomUUID() }));
    });
  });
  return new Promise<void>((resolve) => socialServer.listen(0, '127.0.0.1', () => {
    socialUrl = `http://127.0.0.1:${(socialServer.address() as AddressInfo).port}`; resolve();
  }));
}

describe.skipIf(!HAS_DB)('territory flow (integration)', () => {
  useTestApp();
  beforeAll(startFakeSocial);
  beforeEach(() => {
    forwarded.length = 0;
    configureSocialBridge(null);
  });
  afterAll(async () => {
    configureSocialBridge(null);
    await new Promise<void>((resolve) => socialServer.close(() => resolve()));
  });

  it('verified sweep of CC1 → qualified → claim succeeds → ownership + history recorded', async () => {
    const id = await submitAndVerify('u_aanya', cc1Sweep());
    const v = await api('GET', `/v1/activities/${id}/verification`, 'u_aanya');
    expect(v.body.status).toBe('VERIFIED');

    const zones = await api('GET', `/v1/runs/${id}/zones`, 'u_aanya');
    const cc1 = (zones.body.zones as { zone_id: string; qualification: { status: string; value: number; threshold: number }; actions: { claim: { allowed: boolean } } }[]).find((z) => z.zone_id === 'cc1');
    expect(cc1).toBeTruthy();
    expect(cc1!.qualification.status).toBe('QUALIFIED');
    expect(cc1!.qualification.value).toBeGreaterThanOrEqual(cc1!.qualification.threshold);
    expect(cc1!.actions.claim.allowed).toBe(true);

    const claim = await api('POST', '/v1/zones/cc1/claim', 'u_aanya', { idempotency_key: key() });
    expect(claim.status).toBe(200);
    const t = claim.body.territory as { owner: { user_id: string }; status: string; version: number; shield_until: string };
    expect(t.owner.user_id).toBe('u_aanya');
    expect(t.status).toBe('controlled');
    expect(t.version).toBe(2);
    expect(Date.parse(t.shield_until)).toBeGreaterThan(Date.now());

    const hist = await api('GET', '/v1/zones/cc1/history', null);
    expect((hist.body.history as { action: string; actor: { user_id: string } }[])[0]).toMatchObject({ action: 'CLAIM', actor: { user_id: 'u_aanya' } });

    const qr = await sql<{ status: string }>(`SELECT status FROM qualification_results WHERE activity_id = $1 AND zone_id = 'cc1'`, [id]);
    expect(qr[0]!.status).toBe('CLAIMED'); // eligibility spent
    const me = await api('GET', '/v1/territories/my', 'u_aanya');
    expect((me.body.territories as unknown[]).length).toBe(1);
  });

  it('duplicate claim: same idempotency key replays, new key is rejected as already_owned', async () => {
    const k = key();
    const id = await submitAndVerify('u_aanya', cc1Sweep());
    void id;
    // Already own it from the previous test → new-key claim is 409
    const again = await api('POST', '/v1/zones/cc1/claim', 'u_aanya', { idempotency_key: k });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_owned');
  });

  it('unverified (vehicle) activity cannot claim', async () => {
    const id = await submitAndVerify('u_rhea', trackAlong([[-100, -100], ...sweepRect(CC1.x0, CC1.y0, CC1.x1, CC1.y1, 20), [400, 400]], 14));
    const v = await api('GET', `/v1/activities/${id}/verification`, 'u_rhea');
    expect(v.body.status).toBe('REJECTED');
    const qr = await sql<{ status: string }>(`SELECT status FROM qualification_results WHERE activity_id = $1 AND zone_id = 'cc1'`, [id]);
    expect(qr[0]?.status ?? 'NOT_QUALIFIED').toBe('NOT_QUALIFIED');
    const steal = await api('POST', '/v1/zones/cc1/steal', 'u_rhea', { idempotency_key: key() });
    expect(steal.status).toBe(409);
    expect(['not_qualified', 'shielded']).toContain(steal.body.code);
  });

  it('insufficient coverage (passing through a corner) → not qualified', async () => {
    const id = await submitAndVerify('u_kabir', cc1Corner());
    const zones = await api('GET', `/v1/activities/${id}/zones`, 'u_kabir');
    const cc1 = (zones.body.zones as { zone_id: string; qualification: { status: string } }[]).find((z) => z.zone_id === 'cc1');
    expect(cc1?.qualification.status ?? 'NOT_QUALIFIED').toBe('NOT_QUALIFIED');
    const claim = await api('POST', '/v1/zones/library/claim', 'u_kabir', { idempotency_key: key() });
    expect(claim.status).toBe(409);
    expect(claim.body.code).toBe('not_qualified');
  });

  it('activity still pending verification → qualification_pending', async () => {
    const pts = trackAlong([[-100, -100], ...sweepRect(225, 55, 335, 165, 20), [400, 400]], 3.2);
    const r = await api('POST', '/v1/activities', 'u_kabir', { type: 'run', started_at: pts[0]!.recorded_at, points: pts });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('PENDING');
    const claim = await api('POST', '/v1/zones/library/claim', 'u_kabir', { idempotency_key: key() });
    expect(claim.status).toBe(409);
    expect(claim.body.code).toBe('qualification_pending');
  });

  it('steal: blocked by shield, allowed once the shield lapses, blocked for unqualified users and for the owner', async () => {
    configureSocialBridge({ url: socialUrl, token: 'territory-test-social-token', timeoutMs: 500 });
    await submitAndVerify('u_rhea', cc1Sweep());
    const shielded = await api('POST', '/v1/zones/cc1/steal', 'u_rhea', { idempotency_key: key() });
    expect(shielded.status).toBe(409);
    expect(shielded.body.code).toBe('shielded');
    expect(shielded.body.expires_at).toBeTruthy();

    await sql(`UPDATE territories SET shield_until = now() - interval '1 minute' WHERE zone_id = 'cc1'`);
    const ownerSteal = await api('POST', '/v1/zones/cc1/steal', 'u_aanya', { idempotency_key: key() });
    expect(ownerSteal.body.code).toBe('own_zone');
    const unqualified = await api('POST', '/v1/zones/cc1/steal', 'u_dev', { idempotency_key: key() });
    expect(unqualified.body.code).toBe('not_qualified');

    // Owner now sees the zone under attack
    const detail = await api('GET', '/v1/zones/cc1', 'u_aanya');
    expect((detail.body.territory as { status: string }).status).toBe('under_attack');

    const steal = await api('POST', '/v1/zones/cc1/steal', 'u_rhea', { idempotency_key: key() });
    expect(steal.status).toBe(200);
    expect((steal.body.territory as { owner: { user_id: string }; version: number }).owner.user_id).toBe('u_rhea');
    const ev = (steal.body.event as { action: string; previous_owner: { user_id: string } });
    expect(ev.action).toBe('STEAL');
    expect(ev.previous_owner.user_id).toBe('u_aanya');
    const notif = forwarded.find((n) => n.kind === 'territory.stolen' && n.user_subject === 'u_aanya');
    expect(notif).toMatchObject({ actor_subject: 'u_rhea', title: '{actor} stole your territory', data: { zone_id: 'cc1', route: '/zone/cc1' } });
    expect(notif?.body).toContain('is yours to win back');
  });

  it('defend: only the owner, only under attack, spends the attackers eligibility', async () => {
    // u_rhea owns cc1; u_aanya qualifies again → attack; shield lapses
    await submitAndVerify('u_aanya', cc1Sweep());
    await sql(`UPDATE territories SET shield_until = now() - interval '1 minute' WHERE zone_id = 'cc1'`);
    const notOwner = await api('POST', '/v1/zones/cc1/defend', 'u_aanya', { idempotency_key: key() });
    expect(notOwner.body.code).toBe('not_owner');
    const noQual = await api('POST', '/v1/zones/cc1/defend', 'u_rhea', { idempotency_key: key() });
    expect(noQual.body.code).toBe('not_qualified');
    await submitAndVerify('u_rhea', cc1Sweep());
    const defend = await api('POST', '/v1/zones/cc1/defend', 'u_rhea', { idempotency_key: key() });
    expect(defend.status).toBe(200);
    const t = defend.body.territory as { owner: { user_id: string }; defended_count: number; under_challenge: boolean; status: string };
    expect(t.owner.user_id).toBe('u_rhea');
    expect(t.defended_count).toBe(1);
    expect(t.under_challenge).toBe(false);
    expect(t.status).toBe('controlled');
    const rival = await sql<{ status: string }>(`SELECT status FROM qualification_results WHERE user_id = 'u_aanya' AND zone_id = 'cc1' ORDER BY evaluated_at DESC LIMIT 1`);
    expect(rival[0]!.status).toBe('EXPIRED');
    const calm = await api('POST', '/v1/zones/cc1/defend', 'u_rhea', { idempotency_key: key() });
    expect(calm.body.code).toBe('not_under_attack');
  });

  it('simultaneous claims: exactly one wins, the zone has exactly one owner', async () => {
    const users = ['u_a1', 'u_a2', 'u_a3', 'u_a4'];
    await sql(`UPDATE territories SET owner_id = NULL, owner_type = 'NONE', crew_id = NULL, status = 'UNCLAIMED', shield_until = NULL WHERE zone_id = 'library'`);
    const sweep = () => trackAlong([[-100, -100], ...sweepRect(225, 55, 335, 165, 20), [400, 400]], 3.2);
    for (const u of users) await submitAndVerify(u, sweep());
    const results = await Promise.all(users.map((u) => api('POST', '/v1/zones/library/claim', u, { idempotency_key: key() })));
    const wins = results.filter((r) => r.status === 200);
    expect(wins.length).toBe(1);
    expect(results.filter((r) => r.status === 409 && r.body.code === 'already_owned').length).toBe(3);
    const owners = await sql<{ owner_id: string; version: number }>(`SELECT owner_id, version FROM territories WHERE zone_id = 'library'`);
    expect(owners.length).toBe(1);
    expect(owners[0]!.owner_id).toBe((wins[0]!.body.territory as { owner: { user_id: string } }).owner.user_id);
    const events = await sql(`SELECT 1 FROM territory_events WHERE zone_id = 'library' AND action = 'CLAIM'`);
    expect(events.length).toBe(1);
  });

  it('same user hammering claim with the same key → exactly one write, replays otherwise', async () => {
    await sql(`UPDATE territories SET owner_id = NULL, owner_type = 'NONE', crew_id = NULL, status = 'UNCLAIMED', shield_until = NULL WHERE zone_id = 'mess'`);
    await submitAndVerify('u_dev', trackAlong([[-100, -100], ...sweepRect(70, 195, 210, 270, 20), [400, 400]], 3.2));
    const k = key();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', '/v1/zones/mess/claim', 'u_dev', { idempotency_key: k })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await sql(`SELECT 1 FROM territory_events WHERE zone_id = 'mess'`)).length).toBe(1);
    expect((await sql<{ version: number }>(`SELECT version FROM territories WHERE zone_id = 'mess'`))[0]!.version).toBe(2);
  });

  it('a user cannot claim the same qualification twice (eligibility is spent)', async () => {
    const t = await sql<{ owner_id: string }>(`SELECT owner_id FROM territories WHERE zone_id = 'mess'`);
    expect(t[0]!.owner_id).toBe('u_dev');
    await sql(`UPDATE territories SET owner_id = NULL, owner_type = 'NONE', crew_id = NULL, status = 'UNCLAIMED', shield_until = NULL WHERE zone_id = 'mess'`);
    const again = await api('POST', '/v1/zones/mess/claim', 'u_dev', { idempotency_key: key() });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('not_qualified');
  });

  it('ROUTE zone qualifies by completing the required route, not by area coverage', async () => {
    // Sports loop: required route is an oval of rx 110, ry 70 centred (-380, 230). Run the oval once.
    const loop: [number, number][] = Array.from({ length: 25 }, (_, i) => { const a = (i / 24) * Math.PI * 2; return [-380 + Math.cos(a) * 110, 230 + Math.sin(a) * 70]; });
    const id = await submitAndVerify('u_rhea', trackAlong([[-380, 100], ...loop, [-380, 100]], 3.2));
    const zones = await api('GET', `/v1/activities/${id}/zones`, 'u_rhea');
    const sports = (zones.body.zones as { zone_id: string; interaction: string; qualification: { status: string; metric: string; value: number } }[]).find((z) => z.zone_id === 'sports');
    expect(sports).toBeTruthy();
    expect(sports!.qualification.metric).toBe('route_completion');
    expect(sports!.qualification.value).toBeGreaterThan(0.8);
    expect(sports!.qualification.status).toBe('QUALIFIED');
    expect(sports!.interaction).toBe('looped');
    // Cutting straight across the oval does not complete the route
    const id2 = await submitAndVerify('u_kabir', trackAlong([[-600, 230], [-380, 230], [-180, 230], [0, 230], [200, 230]], 3.2));
    const z2 = (await api('GET', `/v1/activities/${id2}/zones`, 'u_kabir')).body.zones as { zone_id: string; qualification: { status: string } }[];
    expect(z2.find((z) => z.zone_id === 'sports')?.qualification.status ?? 'NOT_QUALIFIED').toBe('NOT_QUALIFIED');
  });

  it('GET /v1/zones and /v1/territories reflect ownership; filters work', async () => {
    const all = await api('GET', '/v1/zones', null);
    expect((all.body.zones as unknown[]).length).toBe(14);
    const mine = await api('GET', '/v1/territories?ownedByMe=true', 'u_rhea');
    expect((mine.body.territories as { zone_id: string }[]).map((t) => t.zone_id)).toContain('cc1');
    const geo = await api('GET', '/v1/zones?format=geojson', null);
    expect(geo.body.type).toBe('FeatureCollection');
    const near = await api('GET', '/v1/zones/nearby?lat=22.9637&lng=88.5245&radius_m=200', null);
    expect((near.body.zones as { id: string }[]).some((z) => z.id === 'cc1')).toBe(true);
  });

  it('leaderboards and stats are computed from real events', async () => {
    const lb = await api('GET', '/v1/leaderboards/squirrels?period=alltime', 'u_rhea');
    expect((lb.body.entries as { user_id: string; xp: number }[]).length).toBeGreaterThan(0);
    expect((lb.body.entries as { xp: number }[])[0]!.xp).toBeGreaterThan(0);
    const hb = await api('GET', '/v1/leaderboards/hostels', null);
    expect((hb.body.entries as unknown[]).length).toBe(3);
    const st = await api('GET', '/v1/stats/daily', null);
    expect(st.body.zones_claimed_today as number).toBeGreaterThan(0);
  });
});
