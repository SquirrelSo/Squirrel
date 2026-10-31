import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureSocialBridge, resetIdentityState } from '../../src/identity/index.js';
import { api, HAS_DB, sql, useTestApp } from './setup.js';

// Crews are Social's (ADR-032). campus-service's own crews table is never written in production,
// so these tests use crews that exist ONLY in Social: nothing is created through POST /v1/crews.
const TOKEN = 'fake-social-crews-token';
const MEMBER = 'crew-member-claimer';
const CREATOR = 'crew-challenge-maker';
const CREW = { id: randomUUID(), name: 'Night Owls', interest: 'running' };

let server: Server;
let socialUrl = '';

function startFakeSocial() {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
      const body = JSON.parse(raw || '{}') as { subjects?: string[]; crew_ids?: string[] };
      const json = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.url === '/internal/v1/crews/memberships') {
        return json({ people: (body.subjects ?? []).map((subject) => ({
          subject, crews: subject === MEMBER ? [{ id: CREW.id, name: CREW.name, role: 'member', joined_at: '2026-09-01T00:00:00Z' }] : [],
        })) });
      }
      if (req.url === '/internal/v1/crews/lookup') {
        return json({ crews: (body.crew_ids ?? []).filter((id) => id === CREW.id).map((id) => ({
          ...CREW, id, scope: 'campus', hostel: null, members_count: 1, members: [{ subject: MEMBER, role: 'member', joined_at: '2026-09-01T00:00:00Z' }],
        })) });
      }
      if (req.url === '/internal/v1/people/resolve') return json({ people: [] });
      if (req.url?.startsWith('/internal/v1/blocks/')) return json({ subject: '', blocked: [], as_of: new Date().toISOString() });
      if (req.url === '/internal/v1/notifications') return json({ created: true, notification_id: randomUUID() });
      res.writeHead(404).end();
    });
  });
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    socialUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

describe.skipIf(!HAS_DB)('crews come from Social (integration)', () => {
  useTestApp();
  beforeAll(async () => { await startFakeSocial(); });
  afterAll(async () => {
    configureSocialBridge(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    resetIdentityState();
    configureSocialBridge({ url: socialUrl, token: TOKEN, timeoutMs: 500, cacheTtlMs: 1000 });
  });

  it('a member of a Social crew can claim a zone, and the territory shows the crew from Social', async () => {
    await api('GET', '/v1/me', MEMBER);
    const activity = randomUUID();
    await sql(`INSERT INTO activities (id, user_id, raw_track, verification_status, activity_type, started_at, updated_at)
               VALUES ($1, $2, ST_GeomFromText('LINESTRING(0 0, 1 1)', 4326), 'VERIFIED', 'run', now(), now())`, [activity, MEMBER]);
    await sql(`INSERT INTO qualification_results (id, user_id, zone_id, status, activity_id, expires_at, interaction, verified)
               VALUES ($1, $2, 'mess', 'QUALIFIED', $3, now() + interval '1 hour', 'visited', true)`, [randomUUID(), MEMBER, activity]);

    const claim = await api('POST', '/v1/zones/mess/claim', MEMBER, { idempotency_key: `ik_${randomUUID()}` });
    expect(claim.status).toBe(200);
    const stored = await sql<{ owner_id: string; crew_id: string }>(`SELECT owner_id, crew_id FROM territories WHERE zone_id = 'mess'`);
    expect(stored[0]).toMatchObject({ owner_id: MEMBER, crew_id: CREW.id });

    const zone = await api('GET', '/v1/zones/mess', MEMBER);
    expect(zone.status).toBe(200);
    expect(zone.body.territory.crew).toMatchObject({ id: CREW.id, name: 'Night Owls', icon: 'run' });
    const list = await api('GET', '/v1/territories', MEMBER);
    const mess = (list.body.territories as { zone_id: string; crew: unknown }[]).find((t) => t.zone_id === 'mess');
    expect(mess?.crew).toMatchObject({ id: CREW.id, name: 'Night Owls' });
  });

  it('a challenge can target a crew that exists only in Social', async () => {
    await api('GET', '/v1/me', CREATOR);
    const created = await api('POST', '/v1/challenges', CREATOR, {
      type: 'weekend_war', target: { type: 'crew', id: CREW.id }, starts_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(created.status).toBe(201);
    expect(created.body.target.crew).toMatchObject({ id: CREW.id, name: 'Night Owls' });
  });

  it('an unknown crew is still refused', async () => {
    await api('GET', '/v1/me', CREATOR);
    const created = await api('POST', '/v1/challenges', CREATOR, {
      type: 'weekend_war', target: { type: 'crew', id: randomUUID() }, starts_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(created.status).toBe(404);
  });
});
