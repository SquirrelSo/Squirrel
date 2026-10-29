import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureSocialBridge, resetIdentityState } from '../../src/identity/index.js';
import { campusNotificationDedupeKey, notify, type NotificationType } from '../../src/notifications/service.js';
import { onRealtime, type RealtimeEvent } from '../../src/realtime/bus.js';
import { api, HAS_DB, sql, submitAndVerify, useTestApp } from './setup.js';
import { sweepRect, trackAlong } from '../helpers.js';

const TOKEN = 'fake-social-notification-token';
const USER = 'notification-recipient';
const ACTOR = 'notification-actor';
type MockCrew = { id: string; name: string; interest: string; scope: string; hostel: string | null; members_count: number; members: { subject: string; role: string; joined_at: string }[] };

type RequestBody = {
  user_subject: string;
  kind: NotificationType;
  actor_subject?: string;
  title: string;
  body?: string;
  actor_fallback: string;
  data: Record<string, unknown>;
  dedupe_key: string;
};

const liveCases: Array<{
  kind: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
}> = [
  { kind: 'territory.stolen', title: '{actor} stole your territory', body: 'Old Library is yours to win back.', data: { zone_id: 'old-library', route: '/zone/old-library' } },
  { kind: 'territory.challenged', title: 'Your territory is at risk', body: '{actor} qualified to challenge Old Library. Defend it!', data: { zone_id: 'old-library', route: '/zone/old-library' } },
  { kind: 'territory.defended', title: 'Your territory was defended', body: '{actor} defended Old Library.', data: { zone_id: 'old-library', route: '/zone/old-library' } },
  { kind: 'zone.claimed', title: '{actor} claimed a crew zone', body: 'Old Library is now held by your crew.', data: { zone_id: 'old-library', route: '/zone/old-library' } },
  { kind: 'challenge.invitation', title: '{actor} challenged you', body: '{actor} challenged you to a Territory duel at Old Library.', data: { invite_id: 'challenge-1', zone_id: 'old-library', route: '/zone/old-library' } },
  { kind: 'challenge.updated', title: 'Challenge updated', body: '{actor} accepted the challenge at Old Library.', data: { invite_id: 'challenge-1', zone_id: 'old-library', route: '/zone/old-library' } },
  { kind: 'meetup.invited', title: 'Meetup invitation', body: '{actor} invited you to a meetup.', data: { meetup_id: 'meetup-1', route: '/meetup/meetup-1' } },
  { kind: 'meetup.accepted', title: 'Meetup accepted', body: '{actor} accepted your meetup invitation.', data: { meetup_id: 'meetup-1', route: '/meetup/meetup-1' } },
  { kind: 'meetup.declined', title: 'Meetup response', body: '{actor} declined your meetup invitation.', data: { meetup_id: 'meetup-1', route: '/meetup/meetup-1' } },
  { kind: 'meetup.cancelled', title: 'Meetup cancelled', body: '{actor} cancelled the meetup.', data: { meetup_id: 'meetup-1', route: '/meetup/meetup-1' } },
  { kind: 'activity.verification_complete', title: 'Activity verified', body: 'Your walk was verified.', data: { activity_id: 'activity-1', route: '/notifications' } },
];

const fake = {
  mode: 'ok' as 'ok' | 'error' | 'null',
  failuresRemaining: 0,
  requests: [] as RequestBody[],
  ids: new Map<string, string>(),
  crews: new Map<string, MockCrew>(),
  clear() { this.mode = 'ok'; this.failuresRemaining = 0; this.requests = []; this.ids.clear(); this.crews.clear(); },
};

let server: Server;
let socialUrl = '';
let stopEvents: (() => void) | null = null;
let events: RealtimeEvent[] = [];

function startFakeSocial() {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
      if (req.method === 'POST' && req.url === '/internal/v1/crews/memberships') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/v1/crews/lookup') {
        const body = JSON.parse(raw || '{}') as { crew_ids?: string[] };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ crews: (body.crew_ids ?? []).map((id) => fake.crews.get(id)).filter(Boolean) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/v1/people/resolve') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [] }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/internal/v1/blocks/')) {
        const subject = decodeURIComponent(req.url.slice('/internal/v1/blocks/'.length));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ subject, blocked: [], as_of: new Date().toISOString() }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/internal/v1/notifications') { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw) as RequestBody;
      fake.requests.push(body);
      if (fake.failuresRemaining > 0) { fake.failuresRemaining -= 1; res.writeHead(503).end('temporary Social outage'); return; }
      if (fake.mode === 'error') { res.writeHead(503).end('Social unavailable'); return; }
      if (fake.mode === 'null') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ created: true, notification_id: null }));
        return;
      }
      const old = fake.ids.get(body.dedupe_key);
      if (old) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ created: false, notification_id: old }));
        return;
      }
      const id = randomUUID();
      fake.ids.set(body.dedupe_key, id);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ created: true, notification_id: id }));
    });
  });
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    socialUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

describe('Social notification forwarding', () => {
  useTestApp();
  beforeAll(async () => { await startFakeSocial(); });
  afterAll(async () => {
    configureSocialBridge(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    fake.clear(); events = [];
    configureSocialBridge({ url: socialUrl, token: TOKEN, timeoutMs: 500, cacheTtlMs: 1000 });
    stopEvents = onRealtime((event) => { if (event.type === 'notification.created') events.push(event); });
  });
  afterEach(() => { stopEvents?.(); stopEvents = null; });

  it('forwards each live campus kind with its template, explicit route and stable dedupe key', async () => {
    for (const [index, item] of liveCases.entries()) {
      const dedupeKey = campusNotificationDedupeKey(item.kind, `source-${index}`, USER);
      await notify(USER, item.kind, item.title, item.body, item.data, item.kind === 'activity.verification_complete' ? null : ACTOR, dedupeKey);
    }

    expect(fake.requests).toHaveLength(11);
    for (const [index, item] of liveCases.entries()) {
      const request = fake.requests[index]!;
      expect(request).toMatchObject({
        user_subject: USER,
        kind: item.kind,
        title: item.title,
        body: item.body,
        actor_fallback: 'Someone',
        data: item.data,
        dedupe_key: campusNotificationDedupeKey(item.kind, `source-${index}`, USER),
      });
      expect(request.title).not.toContain('Maya Runner');
      expect(request.body).not.toContain('Maya Runner');
      if (item.kind !== 'activity.verification_complete') {
        expect(request.actor_subject).toBe(ACTOR);
        expect(`${request.title} ${request.body}`).toContain('{actor}');
      } else {
        expect(request.actor_subject).toBeUndefined();
      }
    }
    expect(events).toHaveLength(11);
    for (const [index, event] of events.entries()) {
      expect((event as Extract<RealtimeEvent, { type: 'notification.created' }>).data).toMatchObject({
        id: fake.ids.get(fake.requests[index]!.dedupe_key),
      });
    }
  });

  it('sends crew challenge ids and routes to that crew', async () => {
    const data = { invite_id: 'crew-challenge', crew_id: '9fdce00c-516f-48cd-bd0a-04b418df756a', route: '/crew/9fdce00c-516f-48cd-bd0a-04b418df756a' };
    await notify(USER, 'challenge.invitation', '{actor} challenged your crew', '{actor} started a Weekend War.', data, ACTOR,
      campusNotificationDedupeKey('challenge.invitation', 'crew-challenge', USER));
    expect(fake.requests[0]?.data).toEqual(data);
  });

  it('routes a group activity challenge without a zone or crew to its notification', async () => {
    await api('GET', '/v1/me', 'group-activity-host');
    await api('GET', '/v1/me', 'group-activity-invitee');
    const created = await api('POST', '/v1/challenges', 'group-activity-host', {
      type: 'group_activity', target: { type: 'user', id: 'group-activity-invitee' },
      starts_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(created.status).toBe(201);
    expect(fake.requests).toContainEqual(expect.objectContaining({
      user_subject: 'group-activity-invitee', kind: 'challenge.invitation',
      data: { invite_id: created.body.id, zone_id: null, crew_id: null, route: '/notifications' },
    }));
  });

  it('loads challenge crew display fields from Social, not the campus crew row', async () => {
    const crewId = randomUUID();
    fake.crews.set(crewId, { id: crewId, name: 'Social Striders', interest: 'running', scope: 'campus', hostel: null, members_count: 1, members: [] });
    await api('GET', '/v1/me', 'crew-challenge-creator');
    const created = await api('POST', '/v1/challenges', 'crew-challenge-creator', {
      type: 'group_activity', target: { type: 'crew', id: crewId },
      starts_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(created.status).toBe(201);
    expect(created.body.target.crew).toMatchObject({ id: crewId, name: 'Social Striders', color: null, icon: 'run' });
  });

  it('publishes no realtime event when Social returns a null notification id', async () => {
    fake.mode = 'null';
    const result = await notify(USER, 'territory.stolen', '{actor} stole your territory', 'Library changed hands.',
      { zone_id: 'library', route: '/zone/library' }, ACTOR, campusNotificationDedupeKey('territory.stolen', 'null-id', USER));
    expect(result).toEqual({ created: true, notification_id: null });
    expect(events).toHaveLength(0);
  });

  it('deduplicates retries to Social and only publishes the first event', async () => {
    const key = campusNotificationDedupeKey('meetup.invited', 'same-meetup', USER);
    const args = [USER, 'meetup.invited', 'Meetup invitation', '{actor} invited you.', { meetup_id: 'same-meetup', route: '/meetup/same-meetup' }, ACTOR, key] as const;
    const first = await notify(...args);
    const second = await notify(...args);
    expect(first?.notification_id).toBeTruthy();
    expect(second?.notification_id).toBe(first?.notification_id);
    expect(second?.created).toBe(false);
    expect(fake.requests).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect((events[0] as Extract<RealtimeEvent, { type: 'notification.created' }>).data).toMatchObject({ id: first?.notification_id });
  });

  it('retries a transient failure asynchronously after 1 second, then publishes Social’s id', async () => {
    fake.failuresRemaining = 1;
    const key = campusNotificationDedupeKey('meetup.invited', 'retry-meetup', USER);
    const result = await notify(USER, 'meetup.invited', 'Meetup invitation', '{actor} invited you.',
      { meetup_id: 'retry-meetup', route: '/meetup/retry-meetup' }, ACTOR, key);
    expect(result).toBeNull();
    expect(fake.requests).toHaveLength(1); // initial response returned without waiting for the retry delay
    const until = Date.now() + 3_000;
    while (fake.requests.length < 2 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.dedupe_key).toBe(key);
    expect(events).toHaveLength(1);
    expect((events[0] as Extract<RealtimeEvent, { type: 'notification.created' }>).data.id).toBe(fake.ids.get(key));
  });

  it.skipIf(!HAS_DB)('a territory steal succeeds when Social is unreachable', async () => {
    configureSocialBridge(null);
    await api('GET', '/v1/me', 'notify-owner');
    await api('GET', '/v1/me', 'notify-attacker');
    await sql(`UPDATE territories SET owner_id = 'notify-owner', owner_type = 'USER', crew_id = NULL, status = 'CLAIMED', shield_until = now() - interval '1 minute', under_challenge = false WHERE zone_id = 'cc1'`);
    const sweep = trackAlong([[-100, -100], ...sweepRect(70, 40, 195, 150, 20), [300, 300], [-100, -100]], 3.2);
    await submitAndVerify('notify-attacker', sweep);
    configureSocialBridge({ url: socialUrl, token: TOKEN, timeoutMs: 500, cacheTtlMs: 1000 });
    fake.mode = 'error';

    const result = await api('POST', '/v1/zones/cc1/steal', 'notify-attacker', { idempotency_key: 'notify-social-down-steal' });
    expect(result.status).toBe(200);
    expect((await sql<{ owner_id: string }>(`SELECT owner_id FROM territories WHERE zone_id = 'cc1'`))[0]?.owner_id).toBe('notify-attacker');
    expect(fake.requests.some((request) => request.kind === 'territory.stolen')).toBe(true);
  });
});
