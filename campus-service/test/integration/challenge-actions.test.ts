import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureSocialBridge, resetIdentityState } from '../../src/identity/index.js';
import { onRealtime } from '../../src/realtime/bus.js';
import { api, HAS_DB, sql, useTestApp } from './setup.js';

const TOKEN = 'challenge-actions-social-token';
const CREW = { id: randomUUID(), name: 'Action Test Crew', interest: 'running' };
const CREW_ROLES = new Map<string, string>();
let membershipUnavailable = false;
let lookupUnavailable = false;
let server: Server;
let socialUrl = '';

function startSocial() {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const json = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      const unavailable = () => res.writeHead(503).end();
      const body = JSON.parse(raw || '{}') as { subjects?: string[]; crew_ids?: string[] };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
      if (req.url === '/internal/v1/crews/memberships') {
        if (membershipUnavailable) return unavailable();
        return json({ people: (body.subjects ?? []).map((subject) => ({
          subject,
          crews: CREW_ROLES.has(subject) ? [{ id: CREW.id, name: CREW.name, role: CREW_ROLES.get(subject), joined_at: '2026-09-01T00:00:00Z' }] : [],
        })) });
      }
      if (req.url === '/internal/v1/crews/lookup') {
        if (lookupUnavailable) return unavailable();
        return json({ crews: (body.crew_ids ?? []).includes(CREW.id) ? [{
          ...CREW, members_count: CREW_ROLES.size,
          members: [...CREW_ROLES].map(([subject, role]) => ({ subject, role, joined_at: '2026-09-01T00:00:00Z' })),
        }] : [] });
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

const future = (ms = 5 * 60_000) => new Date(Date.now() + ms).toISOString();
const base = '/v1/challenges';

async function makeUserChallenge(creator: string, target: string, startsAt = future(), endsAt?: string) {
  await api('GET', '/v1/me', creator);
  await api('GET', '/v1/me', target);
  return api('POST', base, creator, {
    type: 'group_activity', target: { type: 'user', id: target }, starts_at: startsAt,
    ...(endsAt ? { ends_at: endsAt } : {}),
  });
}

async function makeCrewChallenge(creator: string) {
  await api('GET', '/v1/me', creator);
  return api('POST', base, creator, {
    type: 'weekend_war', target: { type: 'crew', id: CREW.id }, starts_at: future(),
  });
}

async function listFor(userId: string, box: 'incoming' | 'outgoing' | 'all' = 'all') {
  const response = await api('GET', `${base}?box=${box}`, userId);
  return response.body.challenges as Array<{ id: string; actions: string[]; actions_status: string; status: string; direction?: string; message?: string | null }>;
}

async function listBodyFor(userId: string, box: 'incoming' | 'outgoing' | 'all' = 'all') {
  return (await api('GET', `${base}?box=${box}`, userId)).body as {
    challenges: Array<{ id: string; actions: string[]; actions_status: string; status: string; direction?: string; message?: string | null }>;
    crew_battles_unavailable: boolean;
  };
}

async function insertCrewBattle(creator: string, crewId: string, message: string) {
  await api('GET', '/v1/me', creator);
  const rows = await sql<{ id: string }>(
    `INSERT INTO challenges (type, created_by, target_type, target_crew_id, starts_at, message)
     VALUES ('weekend_war', $1, 'crew', $2, now() + interval '1 day', $3) RETURNING id`,
    [creator, crewId, message],
  );
  return rows[0]!.id;
}

describe.skipIf(!HAS_DB)('challenge allowed actions (integration)', () => {
  useTestApp();
  beforeAll(startSocial);
  afterAll(async () => {
    configureSocialBridge(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    resetIdentityState();
    CREW_ROLES.clear();
    membershipUnavailable = false;
    lookupUnavailable = false;
    configureSocialBridge({ url: socialUrl, token: TOKEN, timeoutMs: 500, cacheTtlMs: 0 });
  });

  it('the invited user sees accept and decline; the creator does not', async () => {
    const creator = `actions-maker-${randomUUID()}`;
    const invitee = `actions-invitee-${randomUUID()}`;
    await api('GET', '/v1/me', creator);
    await api('GET', '/v1/me', invitee);
    const events: Parameters<Parameters<typeof onRealtime>[0]>[0][] = [];
    const unsubscribe = onRealtime((event) => events.push(event));
    const created = await api('POST', base, creator, {
      type: 'group_activity', target: { type: 'user', id: invitee }, starts_at: future(),
    });
    unsubscribe();
    expect(created.status).toBe(201);
    const challengeEvents = events.filter((event) => event.type === 'challenge.created');
    expect(challengeEvents).toHaveLength(2);
    const creatorEvent = challengeEvents.find((event) => event.type === 'challenge.created' && event.user_ids.includes(creator));
    const inviteeEvent = challengeEvents.find((event) => event.type === 'challenge.created' && event.user_ids.includes(invitee));
    expect((creatorEvent?.data as { actions: string[] }).actions).toEqual(['cancel', 'schedule']);
    expect((inviteeEvent?.data as { actions: string[] }).actions).toEqual(['accept', 'decline']);
    expect((await listFor(invitee))[0]?.actions).toEqual(['accept', 'decline']);
    expect((await listFor(creator))[0]?.actions).toEqual(['cancel', 'schedule']);
  });

  it('the creator sees cancel; the invited side does not, and forbidden omitted actions stay refused', async () => {
    const created = await makeUserChallenge(`actions-maker-${randomUUID()}`, `actions-invitee-${randomUUID()}`);
    const id = created.body.id as string;
    const creator = created.body.from.user_id as string;
    const invitee = created.body.target.person.user_id as string;
    expect((await listFor(creator))[0]?.actions).not.toContain('accept');
    expect((await listFor(invitee))[0]?.actions).not.toContain('cancel');
    expect((await api('POST', `${base}/${id}/accept`, creator)).status).toBe(403);
    expect((await api('POST', `${base}/${id}/cancel`, invitee)).status).toBe(403);
    expect((await api('POST', `${base}/${id}/start`, creator)).status).toBe(409);
  });

  it('Social crew owners and admins see and can accept; a plain member cannot', async () => {
    const owner = `actions-owner-${randomUUID()}`;
    const admin = `actions-admin-${randomUUID()}`;
    const member = `actions-member-${randomUUID()}`;
    CREW_ROLES.set(owner, 'owner'); CREW_ROLES.set(admin, 'admin'); CREW_ROLES.set(member, 'member');
    const ownerInvite = await makeCrewChallenge(`actions-owner-maker-${randomUUID()}`);
    const adminInvite = await makeCrewChallenge(`actions-admin-maker-${randomUUID()}`);
    const memberInvite = await makeCrewChallenge(`actions-member-maker-${randomUUID()}`);
    for (const user of [owner, admin, member]) await api('GET', '/v1/me', user);
    expect((await listFor(owner, 'incoming')).find((x) => x.id === ownerInvite.body.id)?.actions).toEqual(['accept', 'decline']);
    expect((await listFor(admin, 'incoming')).find((x) => x.id === adminInvite.body.id)?.actions).toEqual(['accept', 'decline']);
    expect((await listFor(member, 'incoming')).find((x) => x.id === memberInvite.body.id)?.actions).toEqual([]);
    expect((await api('POST', `${base}/${ownerInvite.body.id}/accept`, owner)).status).toBe(200);
    expect((await api('POST', `${base}/${adminInvite.body.id}/accept`, admin)).status).toBe(200);
    expect((await api('POST', `${base}/${memberInvite.body.id}/accept`, member)).status).toBe(403);
  });

  it('start appears only within the 15-minute early window and the endpoint enforces the same window', async () => {
    const created = await makeUserChallenge(`actions-maker-${randomUUID()}`, `actions-invitee-${randomUUID()}`, future(60 * 60_000));
    const id = created.body.id as string;
    const invitee = created.body.target.person.user_id as string;
    expect((await api('POST', `${base}/${id}/accept`, invitee)).status).toBe(200);
    expect((await listFor(invitee))[0]?.actions).not.toContain('start');
    const early = await api('POST', `${base}/${id}/start`, invitee);
    expect(early.status).toBe(409);
    expect(early.body.detail).toContain('Too early');
  });

  it('complete appears only for an active challenge after its end, and then succeeds', async () => {
    const created = await makeUserChallenge(`actions-maker-${randomUUID()}`, `actions-invitee-${randomUUID()}`, future(), future(30 * 60_000));
    const id = created.body.id as string;
    const invitee = created.body.target.person.user_id as string;
    await api('POST', `${base}/${id}/accept`, invitee);
    const started = await api('POST', `${base}/${id}/start`, invitee);
    expect(started.status).toBe(200);
    expect(started.body.actions).not.toContain('complete');
    const tooSoon = await api('POST', `${base}/${id}/complete`, invitee);
    expect(tooSoon.status).toBe(409);
    await sql(`UPDATE challenges SET ends_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect((await listFor(invitee)).find((x) => x.id === id)?.actions).toContain('complete');
    expect((await api('POST', `${base}/${id}/complete`, invitee)).body.status).toBe('completed');
  });

  it('a decided challenge offers no further actions', async () => {
    const created = await makeUserChallenge(`actions-maker-${randomUUID()}`, `actions-invitee-${randomUUID()}`);
    const id = created.body.id as string;
    const creator = created.body.from.user_id as string;
    const invitee = created.body.target.person.user_id as string;
    expect((await api('POST', `${base}/${id}/decline`, invitee)).status).toBe(200);
    expect((await listFor(invitee)).find((x) => x.id === id)?.actions).toEqual([]);
    expect((await listFor(creator)).find((x) => x.id === id)?.actions).toEqual([]);
  });

  it('Social down with stale known memberships shows only the caller\'s crew battles and hides their messages from others', async () => {
    const member = `actions-stale-member-${randomUUID()}`;
    const creator = `actions-stale-creator-${randomUUID()}`;
    const outsideCrewId = randomUUID();
    CREW_ROLES.set(member, 'member');
    const ownId = await insertCrewBattle(creator, CREW.id, 'known-crew-private-message');
    const outsideId = await insertCrewBattle(creator, outsideCrewId, 'outside-crew-secret-message');

    // A successful lookup primes the caller's membership cache. Leave it intact when Social fails.
    expect((await listFor(member, 'incoming')).some((row) => row.id === ownId)).toBe(true);
    membershipUnavailable = true;
    lookupUnavailable = true;

    const body = await listBodyFor(member, 'incoming');
    const ownRow = body.challenges.find((row) => row.id === ownId);
    expect(ownRow).toMatchObject({ actions: [], actions_status: 'crew_role_unavailable' });
    expect(body.challenges.some((row) => row.id === outsideId)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('outside-crew-secret-message');
    expect(body.crew_battles_unavailable).toBe(false);
  });

  it('Social down with unknown memberships hides all crew battles and reports that they are unavailable', async () => {
    const caller = `actions-cold-caller-${randomUUID()}`;
    await insertCrewBattle(`actions-cold-other-${randomUUID()}`, randomUUID(), 'cold-start-private-message');
    await insertCrewBattle(`actions-cold-visible-creator-${randomUUID()}`, CREW.id, 'cold-start-visible-only-to-members');
    membershipUnavailable = true;
    lookupUnavailable = true;

    const body = await listBodyFor(caller, 'all');
    expect(body.challenges.some((row) => row.message?.startsWith('cold-start-'))).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cold-start-private-message');
    expect(body.crew_battles_unavailable).toBe(true);
  });

  it('a creator outside the target crew sees their outgoing crew challenge with Social up and during an outage', async () => {
    const creator = `actions-outgoing-crew-creator-${randomUUID()}`;
    const created = await makeCrewChallenge(creator);
    const challengeId = created.body.id as string;
    const online = (await listBodyFor(creator, 'outgoing')).challenges.find((row) => row.id === challengeId);
    expect(online?.direction).toBe('outgoing');

    membershipUnavailable = true;
    lookupUnavailable = true;
    const outage = (await listBodyFor(creator, 'outgoing')).challenges.find((row) => row.id === challengeId);
    expect(outage).toMatchObject({ direction: 'outgoing', actions: [], actions_status: 'crew_role_unavailable' });
  });

  it('one-to-one challenges stay in the list ahead of more than 100 crew battles', async () => {
    const caller = `actions-priority-caller-${randomUUID()}`;
    const creator = `actions-priority-creator-${randomUUID()}`;
    CREW_ROLES.set(caller, 'member');
    const direct = await makeUserChallenge(creator, caller);
    const callerId = direct.body.target.person.user_id as string;
    const directId = direct.body.id as string;
    await sql(
      `INSERT INTO challenges (type, created_by, target_type, target_crew_id, starts_at, message, created_at)
       SELECT 'weekend_war', $1, 'crew', $2, now() + interval '1 day', 'crew-row', now() + g * interval '1 millisecond'
       FROM generate_series(1, 105) AS g`,
      [creator, CREW.id],
    );
    const body = await listBodyFor(callerId, 'incoming');
    expect(body.challenges).toHaveLength(100);
    expect(body.challenges.some((row) => row.id === directId)).toBe(true);
  });

  it('a live crew battle stays in the 100-row list ahead of 100 old finished direct challenges', async () => {
    await sql('DELETE FROM challenges');
    const member = `actions-live-crew-member-${randomUUID()}`;
    const creator = `actions-live-crew-creator-${randomUUID()}`;
    CREW_ROLES.set(member, 'member');
    await api('GET', '/v1/me', member);
    await api('GET', '/v1/me', creator);
    const liveCrewId = await insertCrewBattle(creator, CREW.id, 'current crew battle');
    await sql(
      `INSERT INTO challenges (type, created_by, target_type, target_user_id, status, starts_at, message, created_at)
       SELECT 'group_activity', $1, 'user', $2, 'completed', now() - interval '10 days', 'old finished direct', now() - g * interval '1 day'
       FROM generate_series(1, 100) AS g`,
      [creator, member],
    );

    const body = await listBodyFor(member, 'incoming');
    expect(body.challenges).toHaveLength(100);
    expect(body.challenges[0]?.id).toBe(liveCrewId);
    expect(body.challenges.some((row) => row.status === 'completed')).toBe(true);
  });

  it('all advertised actions can be executed, and actions omitted by role, state, or timing are refused', async () => {
    const created = await makeUserChallenge(`actions-maker-${randomUUID()}`, `actions-invitee-${randomUUID()}`);
    const id = created.body.id as string;
    const creator = created.body.from.user_id as string;
    const invitee = created.body.target.person.user_id as string;
    expect((await listFor(creator))[0]?.actions).toContain('cancel');
    expect((await listFor(creator))[0]?.actions).toContain('schedule');
    expect((await api('PATCH', `${base}/${id}/schedule`, creator, { starts_at: future(10 * 60_000) })).status).toBe(200);
    expect((await api('PATCH', `${base}/${id}/schedule`, invitee, { starts_at: future(10 * 60_000) })).status).toBe(403);
    expect((await api('POST', `${base}/${id}/cancel`, creator)).body.status).toBe('cancelled');

    const second = await makeUserChallenge(`actions-maker-${randomUUID()}`, `actions-invitee-${randomUUID()}`);
    const secondId = second.body.id as string;
    const secondInvitee = second.body.target.person.user_id as string;
    expect((await listFor(secondInvitee))[0]?.actions).toContain('accept');
    expect((await api('POST', `${base}/${secondId}/accept`, secondInvitee)).body.status).toBe('accepted');
    expect((await listFor(secondInvitee))[0]?.actions).toContain('start');
    expect((await api('POST', `${base}/${secondId}/start`, secondInvitee)).body.status).toBe('active');
    await sql(`UPDATE challenges SET ends_at = now() - interval '1 second' WHERE id = $1`, [secondId]);
    expect((await listFor(secondInvitee))[0]?.actions).toContain('complete');
    expect((await api('POST', `${base}/${secondId}/complete`, secondInvitee)).body.status).toBe('completed');
    expect((await api('POST', `${base}/${id}/accept`, invitee)).status).toBe(409);
  });
});
