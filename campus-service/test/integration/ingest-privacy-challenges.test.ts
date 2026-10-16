import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { configureSocialBridge } from '../../src/identity/index.js';
import { HAS_DB, useTestApp, api, submitAndVerify, sql } from './setup.js';
import { trackAlong, xyToLatLng, sweepRect } from '../helpers.js';

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
      // Crew lookups answer "no crews": a 404 here would mark Social down, and block checks then fail closed.
      if (req.method === 'POST' && req.url === '/internal/v1/crews/memberships') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [] })); return;
      }
      if (req.method === 'POST' && req.url === '/internal/v1/crews/lookup') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ crews: [] })); return;
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

async function giveVerifiedActivity(userId: string) {
  await api('GET', '/v1/me', userId);
  await sql(`INSERT INTO activities (user_id, activity_type, verification_status, started_at) VALUES ($1, 'walk', 'VERIFIED', now())`, [userId]);
}

describe.skipIf(!HAS_DB)('GPS ingest, privacy, challenges (integration)', () => {
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

  it('rejects malformed GPS payloads with 422 invalid_gps / invalid', async () => {
    const pts = trackAlong([[0, 0], [300, 0]], 3);
    const start = pts[0]!.recorded_at;
    const bad = [
      { points: [{ lat: 'x', lng: 1, recorded_at: start, accuracy_m: 5 }] },                                   // malformed
      { points: pts.slice(0, 1) },                                                                              // single point → still accepted structurally? no: verification rejects; but 1 point is fine at ingest
      { points: [pts[1]!, pts[0]!] },                                                                           // backwards in time
      { points: pts.map((p, i) => (i === 5 ? { ...p, ...xyToLatLng(2500, 0) } : p)) },                          // teleport
      { points: pts.map((p, i) => (i === 3 ? { ...p, accuracy_m: 900 } : p)) },                                 // accuracy
      { points: pts.map((p) => ({ ...p, lat: p.lat + 0.5 })) },                                                 // off-campus
    ];
    for (const [i, b] of bad.entries()) {
      const r = await api('POST', '/v1/activities', 'u_dev', { type: 'run', started_at: start, ...b });
      if (i === 1) { expect(r.status).toBe(201); continue; }
      expect(r.status, `case ${i}`).toBe(422);
      expect(['invalid_gps', 'invalid']).toContain(r.body.code);
    }
  });

  it('batch upload: seq ordering, idempotent batches, finish → PENDING → verified', async () => {
    const pts = trackAlong([[-100, -100], ...sweepRect(70, 40, 195, 150, 20), [300, 300]], 3.2);
    const create = await api('POST', '/v1/activities', 'u_dev', { type: 'run', started_at: pts[0]!.recorded_at });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('RECORDING');
    const id = create.body.activity_id as string;
    const half = Math.floor(pts.length / 2);
    const b1 = await api('POST', `/v1/activities/${id}/points`, 'u_dev', { idempotency_key: 'b1', points: pts.slice(0, half).map((p) => ({ ...p, seq: undefined })) });
    expect(b1.status).toBe(200);
    expect(b1.body.accepted).toBe(half);
    const b1again = await api('POST', `/v1/activities/${id}/points`, 'u_dev', { idempotency_key: 'b1', points: pts.slice(0, half) });
    expect(b1again.body.replayed).toBe(true);
    const back = await api('POST', `/v1/activities/${id}/points`, 'u_dev', { idempotency_key: 'b0', points: pts.slice(0, 3) });
    expect(back.body.replayed).toBe(true); // already-stored range → harmless
    const b2 = await api('POST', `/v1/activities/${id}/points`, 'u_dev', { idempotency_key: 'b2', points: pts.slice(half) });
    expect(b2.body.point_count).toBe(pts.length);
    const other = await api('POST', `/v1/activities/${id}/points`, 'u_rhea', { points: pts.slice(0, 2) });
    expect(other.status).toBe(404); // not your activity
    const fin = await api('POST', `/v1/activities/${id}/finish`, 'u_dev', { client_distance_m: 1500 });
    expect(fin.body.status).toBe('PENDING');
    const late = await api('POST', `/v1/activities/${id}/points`, 'u_dev', { points: pts.slice(0, 2) });
    expect(late.status).toBe(409);
    const { verifyActivity } = await import('../../src/verification/worker.js');
    await verifyActivity(id, { info() {}, warn() {}, error() {} });
    const v = await api('GET', `/v1/activities/${id}`, 'u_dev');
    expect(v.body.status).toBe('VERIFIED');
    expect(v.body.distance_m as number).toBeGreaterThan(1000);
    expect(v.body.track).toBeTruthy();
    const list = await api('GET', '/v1/activities?limit=5', 'u_dev');
    expect((list.body.items as { id: string }[])[0]!.id).toBe(id);
    // The raw anti-cheat score/signals never leak
    expect(JSON.stringify(v.body)).not.toMatch(/anti_cheat_score|verification_signals/);
  });

  it('too few points → REJECTED with no_points, never qualifies', async () => {
    const pts = trackAlong([[0, 0], [300, 0]], 3).slice(0, 1);
    const id = await submitAndVerify('u_dev', pts);
    const v = await api('GET', `/v1/activities/${id}/verification`, 'u_dev');
    expect(v.body.status).toBe('REJECTED');
    expect((await sql(`SELECT 1 FROM qualification_results WHERE activity_id = $1 AND status = 'QUALIFIED'`, [id])).length).toBe(0);
  });

  it('presence: exact location is never exposed; nearby requires mutual open-to-meet', async () => {
    const a = xyToLatLng(0, 0), b = xyToLatLng(100, 0), far = xyToLatLng(1500, 0);
    expect((await api('PUT', '/v1/map/presence', 'u_aanya', { lat: a.lat, lng: a.lng, accuracy_m: 8 })).body.accepted).toBe(true);
    expect((await api('PUT', '/v1/map/presence', 'u_rhea', { lat: b.lat, lng: b.lng, accuracy_m: 8 })).body.accepted).toBe(true);
    expect((await api('PUT', '/v1/map/presence', 'u_kabir', { lat: far.lat, lng: far.lng, accuracy_m: 8 })).body.accepted).toBe(true);
    await api('POST', '/v1/activities', 'u_rhea', { type: 'run', started_at: new Date().toISOString() }); // rhea is active now

    await Promise.all(['u_aanya', 'u_rhea', 'u_kabir'].map(giveVerifiedActivity));

    const closed = await api('GET', '/v1/people/active', 'u_aanya');
    expect(closed.body.visible).toBe(false);
    expect((closed.body.nearby as unknown[]).length).toBe(0);
    expect((closed.body.active as { person: { user_id: string }; proximity: string | null }[]).find((p) => p.person.user_id === 'u_rhea')!.proximity).toBeNull();

    await api('PUT', '/v1/me/open-to-meet', 'u_aanya', { enabled: true });
    const oneSided = await api('GET', '/v1/people/active', 'u_aanya');
    expect((oneSided.body.nearby as unknown[]).length).toBe(0); // rhea not open

    await api('PUT', '/v1/me/open-to-meet', 'u_rhea', { enabled: true });
    await api('PUT', '/v1/me/open-to-meet', 'u_kabir', { enabled: true });
    const mutual = await api('GET', '/v1/people/active', 'u_aanya');
    const nearby = mutual.body.nearby as { person: { user_id: string }; proximity: string }[];
    expect(nearby.map((n) => n.person.user_id)).toEqual(['u_rhea']); // kabir is 1.5 km away → outside radius
    expect(nearby[0]!.proximity).toBe('very_close');
    expect(JSON.stringify(mutual.body)).not.toMatch(/"lat"|"lng"|latitude|longitude/);

    const players = await api('GET', '/v1/map/players', 'u_aanya');
    const rhea = (players.body.players as { user_id: string; position: [number, number]; precision_m: number }[]).find((p) => p.user_id === 'u_rhea')!;
    expect(rhea.precision_m).toBe(100);
    expect(rhea.position[0]).not.toBe(b.lat); // snapped, not raw
  });

  it('challenge lifecycle with server-decided result', async () => {
    configureSocialBridge({ url: socialUrl, token: 'challenges-test-social-token', timeoutMs: 500 });
    const soon = new Date(Date.now() + 60_000).toISOString();
    const bad = await api('POST', '/v1/challenge-invites', 'u_aanya', { type: 'territory', target: { type: 'user', id: 'u_rhea' }, starts_at: soon });
    expect(bad.status).toBe(422); // territory needs a zone
    const self = await api('POST', '/v1/challenge-invites', 'u_aanya', { type: 'territory', target: { type: 'user', id: 'u_aanya' }, zone_id: 'cc1', starts_at: soon });
    expect(self.status).toBe(422);
    const created = await api('POST', '/v1/challenge-invites', 'u_aanya', { type: 'territory', target: { type: 'user', id: 'u_rhea' }, zone_id: 'cc1', starts_at: soon, message: 'Let’s go' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body.status).toBe('pending');
    const dup = await api('POST', '/v1/challenge-invites', 'u_aanya', { type: 'territory', target: { type: 'user', id: 'u_rhea' }, zone_id: 'cc1', starts_at: soon });
    expect(dup.status).toBe(409);
    const wrongSide = await api('POST', `/v1/challenge-invites/${id}/accept`, 'u_aanya');
    expect(wrongSide.status).toBe(403);
    const inbox = await api('GET', '/v1/challenge-invites?box=incoming', 'u_rhea');
    expect((inbox.body.invites as { id: string; direction: string }[])[0]).toMatchObject({ id, direction: 'incoming' });
    expect((await api('POST', `/v1/challenge-invites/${id}/accept`, 'u_rhea')).body.status).toBe('accepted');
    expect((await api('POST', `/v1/challenge-invites/${id}/start`, 'u_rhea')).body.status).toBe('active');
    // cc1 is owned by u_rhea (from the previous suite state? this suite has a fresh DB) → claim it first
    await sql(`UPDATE territories SET owner_id = 'u_rhea', owner_type = 'USER', status = 'CLAIMED', claimed_at = now() WHERE zone_id = 'cc1'`);
    const done = await api('POST', `/v1/challenge-invites/${id}/complete`, 'u_aanya');
    expect(done.body.status).toBe('completed');
    expect((done.body.result as { winner: { user_id: string } }).winner.user_id).toBe('u_rhea');
    const notif = forwarded.find((n) => n.kind === 'challenge.invitation' && n.user_subject === 'u_rhea');
    expect(notif).toMatchObject({ actor_subject: 'u_aanya', title: '{actor} challenged you', data: { invite_id: id, zone_id: 'cc1', route: '/zone/cc1' } });
    expect(notif?.body).toContain('{actor} challenged you to Territory duel');
  });

  it('auth: missing/invalid token → 401; other users activities → 404; unknown routes → 404 JSON', async () => {
    expect((await api('GET', '/v1/me', null)).status).toBe(401);
    const res = await (await import('./setup.js')).app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
    expect((await api('GET', '/v1/nope', null)).body.code).toBe('not_found');
    const me = await api('GET', '/v1/me', 'u_new_user');
    expect(me.status).toBe(200);
    expect(me.body.user_id).toBe('u_new_user'); // JIT provisioned
  });
});
