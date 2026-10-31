/**
 * Identity bridge to Social, against a fake Social server (node:http) implementing
 * POST /internal/v1/people/resolve exactly as specified in src/identity/index.ts.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureSocialBridge, resetIdentityState } from '../../src/identity/index.js';
import { trackAlong, sweepRect } from '../helpers.js';
import { api, app, HAS_DB, sql, submitAndVerify, tokenFor, useTestApp } from './setup.js';

const TOKEN = 'test-internal-token';
type Person = { subject: string; profile_id: string; username: string; display_name: string; avatar_url: string | null; hostel: string | null; level: number };
type NotificationRequest = { user_subject: string; kind: string; actor_subject?: string; title: string; body?: string; data: Record<string, unknown>; dedupe_key: string };

const social = {
  people: new Map<string, Person>(),     // subject → person
  mode: 'ok' as 'ok' | 'error' | 'hang',
  calls: [] as { subjects?: string[]; profile_ids?: string[] }[],
  notifications: [] as NotificationRequest[],
  byProfile(pid: string) { return [...this.people.values()].find((p) => p.profile_id === pid); },
  add(subject: string, display_name: string, extra: Partial<Person> = {}) {
    const p: Person = { subject, profile_id: randomUUID(), username: subject.replace(/^u_/, ''), display_name, avatar_url: `https://cdn.social.test/${subject}.png`, hostel: null, level: 3, ...extra };
    this.people.set(subject, p);
    return p;
  },
};

let server: Server;
let socialUrl = '';

function startFakeSocial() {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (social.mode === 'hang') return; // never answers → client timeout
      if (social.mode === 'error') { res.writeHead(500).end('boom'); return; }
      if (req.method === 'GET' && req.url?.startsWith('/internal/v1/blocks/')) {
        const sub = req.url.split('/internal/v1/blocks/')[1];
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ subject: sub, blocked: [], as_of: new Date().toISOString() }));
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/v1/crews/memberships') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/v1/crews/lookup') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ crews: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/v1/notifications') {
        const body = JSON.parse(raw || '{}') as NotificationRequest;
        social.notifications.push(body);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ created: true, notification_id: randomUUID() }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/internal/v1/people/resolve') { res.writeHead(404).end(); return; }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
      const body = JSON.parse(raw || '{}') as { subjects?: string[]; profile_ids?: string[] };
      social.calls.push(body);
      const out: Person[] = [];
      for (const s of body.subjects ?? []) out.push(social.people.get(s) ?? social.add(s, `Social ${s}`)); // unknown subjects are provisioned
      for (const pid of body.profile_ids ?? []) { const p = social.byProfile(pid); if (p) out.push(p); }  // unknown profile ids omitted
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: out }));
    });
  });
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { socialUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }));
}

const bridgeOn = () => configureSocialBridge({ url: socialUrl, token: TOKEN, timeoutMs: 300 });
const key = () => `k-${Math.random().toString(36).slice(2)}`;
const future = () => new Date(Date.now() + 60 * 60_000).toISOString();
const CC1 = { x0: 70, y0: 40, x1: 195, y1: 150 };
const cc1Sweep = () => trackAlong([[-100, -100], [CC1.x0, CC1.y0 + 5], ...sweepRect(CC1.x0, CC1.y0, CC1.x1, CC1.y1, 20), [300, 300], [-100, -100]], 3.2);

describe.skipIf(!HAS_DB)('identity bridge to Social (integration)', () => {
  beforeAll(startFakeSocial);
  useTestApp();
  beforeEach(() => { social.mode = 'ok'; bridgeOn(); });
  afterAll(async () => { configureSocialBridge(undefined); server.closeAllConnections(); await new Promise((r) => server.close(r)); });

  it('/v1/me: user_id is the Social profile id, name/avatar/hostel come from Social and are persisted', async () => {
    const p = social.add('u_ib_me', 'Ishita Bose', { hostel: 'Tapti' });
    const me = await api('GET', '/v1/me', 'u_ib_me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user_id: p.profile_id, display_name: 'Ishita Bose', avatar_url: p.avatar_url, hostel: 'Tapti' });
    const row = await sql<{ display_name: string; avatar_url: string }>(`SELECT display_name, avatar_url FROM users WHERE id = 'u_ib_me'`);
    expect(row[0]).toEqual({ display_name: 'Ishita Bose', avatar_url: p.avatar_url });
    // unknown subjects are provisioned by Social: a brand-new user still gets a real Social identity
    const fresh = await api('GET', '/v1/me', 'u_ib_brand_new');
    expect(fresh.body.user_id).toBe(social.people.get('u_ib_brand_new')!.profile_id);
    expect(fresh.body.display_name).toBe('Social u_ib_brand_new');
  });

  it('a renamed Social profile is picked up after the cache expires and written back to users', async () => {
    social.add('u_ib_rename', 'Old Name');
    expect((await api('GET', '/v1/me', 'u_ib_rename')).body.display_name).toBe('Old Name');
    social.people.get('u_ib_rename')!.display_name = 'New Name';
    resetIdentityState(); // = TTL elapsed
    await api('GET', '/v1/users/u_ib_rename', null);
    expect((await sql<{ display_name: string }>(`SELECT display_name FROM users WHERE id = 'u_ib_rename'`))[0]!.display_name).toBe('New Name');
  });

  it('territory owner, history actor, steal notification (actor, data.user_id, text) and leaderboard use Social identity', async () => {
    const owner = social.add('u_ib_owner', 'Olivia Owner');
    const thief = social.add('u_ib_thief', 'Tariq Thief');
    social.notifications = [];
    await submitAndVerify('u_ib_owner', cc1Sweep());
    const claimKey = key();
    const claim = await api('POST', '/v1/zones/cc1/claim', 'u_ib_owner', { idempotency_key: claimKey });
    expect(claim.status).toBe(200);
    expect((claim.body.territory as { owner: { user_id: string; display_name: string } }).owner).toMatchObject({ user_id: owner.profile_id, display_name: 'Olivia Owner' });
    expect(claim.body.event).toMatchObject({ actor: { user_id: owner.profile_id }, new_owner_id: owner.profile_id });
    // an idempotent replay (stored with campus ids) is translated too
    const replay = await api('POST', '/v1/zones/cc1/claim', 'u_ib_owner', { idempotency_key: claimKey });
    expect((replay.body.territory as { owner: { user_id: string } }).owner.user_id).toBe(owner.profile_id);

    await sql(`UPDATE territories SET shield_until = now() - interval '1 minute' WHERE zone_id = 'cc1'`);
    await submitAndVerify('u_ib_thief', cc1Sweep());
    const steal = await api('POST', '/v1/zones/cc1/steal', 'u_ib_thief', { idempotency_key: key() });
    expect(steal.status).toBe(200);

    const zone = await api('GET', '/v1/zones/cc1', null);
    expect((zone.body.territory as { owner: { user_id: string } }).owner.user_id).toBe(thief.profile_id);
    const hist = zone.body.history as { action: string; actor: { user_id: string; display_name: string }; previous_owner: { user_id: string } | null }[];
    expect(hist[0]).toMatchObject({ action: 'STEAL', actor: { user_id: thief.profile_id, display_name: 'Tariq Thief' }, previous_owner: { user_id: owner.profile_id } });
    const all = await api('GET', '/v1/territories', null);
    expect((all.body.territories as { zone_id: string; owner: { user_id: string } | null }[]).find((t) => t.zone_id === 'cc1')!.owner!.user_id).toBe(thief.profile_id);

    const stolen = social.notifications.find((n) => n.kind === 'territory.stolen' && n.user_subject === 'u_ib_owner')!;
    expect(stolen).toMatchObject({ user_subject: 'u_ib_owner', actor_subject: 'u_ib_thief', title: '{actor} stole your territory' });
    expect(stolen.body).toContain('yours to win back');
    expect(stolen.data).toMatchObject({ zone_id: 'cc1', route: '/zone/cc1' });
    expect(stolen.data).not.toHaveProperty('user_id');

    const board = await api('GET', '/v1/leaderboards/squirrels?period=alltime', 'u_ib_thief');
    const entries = board.body.entries as { user_id: string; display_name: string }[];
    expect(entries.find((e) => e.user_id === thief.profile_id)?.display_name).toBe('Tariq Thief');
    expect(entries.some((e) => e.user_id.startsWith('u_ib_'))).toBe(false);
    expect((board.body.me as { user_id: string }).user_id).toBe(thief.profile_id);
  });

  it('accepts profile ids in /v1/users/:id, /context and /block; unknown ids are 404; campus ids still work', async () => {
    const viewer = social.add('u_ib_viewer', 'Vera Viewer');
    const target = social.add('u_ib_target', 'Tara Target');
    await api('GET', '/v1/me', 'u_ib_viewer');
    await api('GET', '/v1/me', 'u_ib_target');

    const profile = await api('GET', `/v1/users/${target.profile_id}`, 'u_ib_viewer');
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ user_id: target.profile_id, display_name: 'Tara Target' });
    expect((await api('GET', `/v1/users/${target.profile_id}/context`, 'u_ib_viewer')).status).toBe(200);
    expect((await api('GET', '/v1/users/u_ib_target', 'u_ib_viewer')).body.user_id).toBe(target.profile_id); // campus id accepted as-is
    expect((await api('GET', `/v1/users/${randomUUID()}`, 'u_ib_viewer')).status).toBe(404);
    expect((await api('GET', `/v1/users/${randomUUID()}/context`, 'u_ib_viewer')).status).toBe(404);

    const blocked = await api('POST', `/v1/users/${target.profile_id}/block`, 'u_ib_viewer');
    expect(blocked.status).toBe(200);
    expect(blocked.body).toEqual({ blocked: true, user_id: target.profile_id });
    expect(await sql(`SELECT 1 FROM blocks WHERE blocker_id = 'u_ib_viewer' AND blocked_id = 'u_ib_target'`)).toHaveLength(1);
    const list = (await api('GET', '/v1/me/blocks', 'u_ib_viewer')).body.blocks as { user_id: string; person: { user_id: string; display_name: string } }[];
    expect(list).toEqual([expect.objectContaining({ user_id: target.profile_id, person: expect.objectContaining({ user_id: target.profile_id, display_name: 'Tara Target' }) })]);
    expect((await api('POST', `/v1/users/${viewer.profile_id}/block`, 'u_ib_viewer')).status).toBe(422); // self, by profile id
    expect((await api('POST', `/v1/users/${randomUUID()}/block`, 'u_ib_viewer')).status).toBe(404);

    const unblock = await app.inject({ method: 'DELETE', url: `/v1/users/${target.profile_id}/block`, headers: { authorization: `Bearer ${await tokenFor('u_ib_viewer')}` } });
    expect(unblock.json()).toEqual({ blocked: false, user_id: target.profile_id });
    expect(await sql(`SELECT 1 FROM blocks WHERE blocker_id = 'u_ib_viewer'`)).toHaveLength(0);
  });

  it('meetup invitees and challenge targets may be profile ids; participants and notifications carry profile ids', async () => {
    const host = social.add('u_ib_host', 'Hema Host');
    const guest = social.add('u_ib_guest', 'Gautam Guest');
    const other = social.add('u_ib_other', 'Omar Other');
    for (const u of ['u_ib_host', 'u_ib_guest', 'u_ib_other']) await api('GET', '/v1/me', u);

    const created = await api('POST', '/v1/meetups', 'u_ib_host', { place_text: 'Cafe', starts_at: future(), invitee_ids: [guest.profile_id, 'u_ib_other'] });
    expect(created.status).toBe(201);
    expect(created.body.created_by).toBe(host.profile_id);
    const parts = created.body.participants as { user_id: string; person: { user_id: string; display_name: string } }[];
    expect(parts.map((p) => p.user_id).sort()).toEqual([host.profile_id, guest.profile_id, other.profile_id].sort());
    expect(parts.find((p) => p.user_id === guest.profile_id)!.person.display_name).toBe('Gautam Guest');
    expect((await sql(`SELECT user_id FROM meetup_participants WHERE meetup_id = $1 ORDER BY user_id`, [created.body.id])).map((r) => r.user_id)).toEqual(['u_ib_guest', 'u_ib_host', 'u_ib_other']);

    const invite = social.notifications.find((n) => n.kind === 'meetup.invited' && n.user_subject === 'u_ib_guest')!;
    expect(invite).toMatchObject({ actor_subject: 'u_ib_host', title: 'Meetup invitation', body: '{actor} invited you to a meetup.' });
    expect(invite.data.route).toBe(`/meetup/${created.body.id}`);

    expect((await api('POST', '/v1/meetups', 'u_ib_host', { place_text: 'Cafe', starts_at: future(), invitee_ids: [host.profile_id] })).status).toBe(422); // yourself
    expect((await api('POST', '/v1/meetups', 'u_ib_host', { place_text: 'Cafe', starts_at: future(), invitee_ids: [guest.profile_id, 'u_ib_guest'] })).status).toBe(422); // same person twice
    expect((await api('POST', '/v1/meetups', 'u_ib_host', { place_text: 'Cafe', starts_at: future(), invitee_ids: [randomUUID()] })).status).toBe(404);

    const ch = await api('POST', '/v1/challenges', 'u_ib_host', { type: 'territory', target: { type: 'user', id: guest.profile_id }, zone_id: 'library', starts_at: future() });
    expect(ch.status).toBe(201);
    expect(ch.body).toMatchObject({ from: { user_id: host.profile_id, display_name: 'Hema Host' }, target: { type: 'user', person: { user_id: guest.profile_id } } });
    expect((await sql(`SELECT target_user_id FROM challenges WHERE id = $1`, [ch.body.id]))[0]!.target_user_id).toBe('u_ib_guest');
    const challengeInvite = social.notifications.find((n) => n.kind === 'challenge.invitation' && n.user_subject === 'u_ib_guest')!;
    expect(challengeInvite).toMatchObject({ actor_subject: 'u_ib_host', title: '{actor} challenged you' });
    expect(challengeInvite.data).toMatchObject({ zone_id: 'library', route: '/zone/library' });
  });

  it('realtime: auth.ok and territory frames carry profile ids', async () => {
    const p = social.add('u_ib_ws', 'Wren Socket');
    await api('GET', '/v1/me', 'u_ib_ws');
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/realtime`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const frames: { type: string; data: Record<string, unknown> }[] = [];
    ws.on('message', (m: Buffer) => frames.push(JSON.parse(String(m))));
    const waitFor = async (type: string) => { for (let i = 0; i < 100 && !frames.some((f) => f.type === type); i++) await new Promise((r) => setTimeout(r, 20)); return frames.find((f) => f.type === type); };
    ws.send(JSON.stringify({ type: 'auth', token: await tokenFor('u_ib_ws') }));
    expect((await waitFor('auth.ok'))?.data.user_id).toBe(p.profile_id);
    await submitAndVerify('u_ib_ws', trackAlong([[-100, -100], ...sweepRect(225, 55, 335, 165, 20), [400, 400]], 3.2)); // library
    expect((await api('POST', '/v1/zones/library/claim', 'u_ib_ws', { idempotency_key: key() })).status).toBe(200);
    const claimed = await waitFor('territory.claimed');
    expect((claimed?.data.owner as { user_id: string; display_name: string })).toMatchObject({ user_id: p.profile_id, display_name: 'Wren Socket' });
    ws.terminate();
  });

  it('Social erroring or timing out → campus fallback (id = sub, campus name), never a 5xx', async () => {
    for (const mode of ['error', 'hang'] as const) {
      resetIdentityState();
      social.mode = mode;
      const sub = `u_ib_down_${mode}`;
      const me = await api('GET', '/v1/me', sub);
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ user_id: sub, display_name: sub }); // token name claim, as without the bridge
      const board = await api('GET', '/v1/leaderboards/squirrels', sub);
      expect(board.status).toBe(200);
      expect((await api('GET', `/v1/users/${randomUUID()}`, sub)).status).toBe(404);
      expect((await api('GET', `/v1/users/${sub}`, sub)).body.user_id).toBe(sub);
    }
    // wrong internal token (401) → same fallback
    configureSocialBridge({ url: socialUrl, token: 'wrong', timeoutMs: 300 });
    social.mode = 'ok';
    const me = await api('GET', '/v1/me', 'u_ib_badtoken');
    expect(me.status).toBe(200);
    expect(me.body.user_id).toBe('u_ib_badtoken');
  });

  it('bridge off → campus ids and names, Social never called', async () => {
    configureSocialBridge(null);
    const calls = social.calls.length;
    social.add('u_ib_off', 'Should Not Appear');
    const me = await api('GET', '/v1/me', 'u_ib_off');
    expect(me.body).toMatchObject({ user_id: 'u_ib_off', display_name: 'u_ib_off' });
    const pid = social.people.get('u_ib_owner')!.profile_id;
    expect((await api('GET', `/v1/users/${pid}`, 'u_ib_off')).status).toBe(404);
    const zone = await api('GET', '/v1/zones/cc1', null);
    expect((zone.body.territory as { owner: { user_id: string; display_name: string } }).owner.user_id).toBe('u_ib_thief');
    expect(social.calls.length).toBe(calls);
  });
});
