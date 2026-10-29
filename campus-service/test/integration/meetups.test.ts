import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureSocialBridge } from '../../src/identity/index.js';
import { api, HAS_DB, sql, useTestApp } from './setup.js';

const future = () => new Date(Date.now() + 60 * 60_000).toISOString();
const provision = async (...ids: string[]) => { for (const id of ids) await api('GET', '/v1/me', id); };

type Forwarded = { user_subject: string; kind: string; actor_subject?: string; title: string; body?: string; data: Record<string, unknown>; dedupe_key: string };
const social = { requests: [] as Forwarded[], ids: new Map<string, string>() };
let socialServer: Server;
let socialUrl = '';

function startFakeSocial() {
  socialServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.startsWith('/internal/v1/blocks/')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ blocked: [] })); return;
      }
      if (req.method === 'POST' && req.url === '/internal/v1/people/resolve') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [] })); return;
      }
      if (req.method === 'POST' && (req.url === '/internal/v1/crews/memberships' || req.url === '/internal/v1/crews/lookup')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [], crews: [] })); return;
      }
      if (req.method !== 'POST' || req.url !== '/internal/v1/notifications') { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw || '{}') as Forwarded;
      social.requests.push(body);
      const old = social.ids.get(body.dedupe_key);
      if (old) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ created: false, notification_id: old })); return; }
      const id = randomUUID(); social.ids.set(body.dedupe_key, id);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ created: true, notification_id: id }));
    });
  });
  return new Promise<void>((resolve) => socialServer.listen(0, '127.0.0.1', () => {
    socialUrl = `http://127.0.0.1:${(socialServer.address() as AddressInfo).port}`; resolve();
  }));
}

const forwarded = (kind: string, recipient: string) => social.requests.filter((n) => n.kind === kind && n.user_subject === recipient);

async function createMeetup(host: string, invitees: string[], extra: Record<string, unknown> = {}) {
  const created = await api('POST', '/v1/meetups', host, { place_text: 'Campus cafe', starts_at: future(), invitee_ids: invitees, ...extra });
  return created;
}

describe.skipIf(!HAS_DB)('meetups (integration)', () => {
  useTestApp();
  beforeAll(startFakeSocial);
  beforeEach(() => {
    social.requests = []; social.ids.clear();
    configureSocialBridge({ url: socialUrl, token: 'meetups-test-social-token', timeoutMs: 500 });
  });
  afterAll(async () => {
    configureSocialBridge(null);
    await new Promise<void>((resolve) => socialServer.close(() => resolve()));
  });

  it('creates with two invitees: proposed, three participant rows, host accepted', async () => {
    await provision('u_mh1', 'u_mg1', 'u_mg2');
    const created = await createMeetup('u_mh1', ['u_mg1', 'u_mg2']);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('proposed');
    expect(created.body.participants).toHaveLength(3);
    expect((created.body.participants as { user_id: string; role: string; status: string }[])).toContainEqual(expect.objectContaining({ user_id: 'u_mh1', role: 'host', status: 'accepted' }));
    expect(await sql(`SELECT meetup_id FROM meetup_participants WHERE meetup_id = $1`, [created.body.id])).toHaveLength(3);
    expect(forwarded('meetup.invited', 'u_mg1')).toEqual([expect.objectContaining({ actor_subject: 'u_mh1', title: 'Meetup invitation', body: '{actor} invited you to a meetup.', data: { meetup_id: created.body.id, route: `/meetup/${created.body.id}` } })]);
  });

  it('one guest accepts and status becomes confirmed; open_to_meet false does not gate invitation or acceptance', async () => {
    await provision('u_mh2', 'u_mg3');
    await api('PUT', '/v1/me/open-to-meet', 'u_mg3', { enabled: false });
    const created = await createMeetup('u_mh2', ['u_mg3']);
    expect(created.status).toBe(201);
    const invitee = (created.body.participants as { user_id: string; person: { open_to_meet: boolean } }[]).find((p) => p.user_id === 'u_mg3');
    expect(invitee?.person.open_to_meet).toBe(false);
    const accepted = await api('POST', `/v1/meetups/${created.body.id}/accept`, 'u_mg3');
    expect(accepted.body.status).toBe('confirmed');
    expect((accepted.body.participants as { user_id: string; status: string }[]).find((p) => p.user_id === 'u_mg3')?.status).toBe('accepted');
    expect(forwarded('meetup.accepted', 'u_mh2')).toEqual([expect.objectContaining({ actor_subject: 'u_mg3', title: 'Meetup accepted', body: '{actor} accepted your meetup invitation.', data: { meetup_id: created.body.id, status: 'accepted', route: `/meetup/${created.body.id}` } })]);
  });

  it('every guest declining leaves the meetup open until host cancels it', async () => {
    await provision('u_mh3', 'u_mg4', 'u_mg5');
    const created = await createMeetup('u_mh3', ['u_mg4', 'u_mg5']);
    const id = created.body.id as string;
    expect((await api('POST', `/v1/meetups/${id}/decline`, 'u_mg4', { reason: 'private' })).status).toBe(422);
    expect((await api('POST', `/v1/meetups/${id}/decline`, 'u_mg4')).body.status).toBe('proposed');
    expect((await api('POST', `/v1/meetups/${id}/decline`, 'u_mg5')).body.status).toBe('proposed');
    const declines = forwarded('meetup.declined', 'u_mh3');
    expect(declines).toHaveLength(2);
    expect(declines.map((n) => n.actor_subject).sort()).toEqual(['u_mg4', 'u_mg5']);
    expect(declines.every((n) => Object.keys(n.data).sort().join(',') === 'meetup_id,route,status')).toBe(true);
    expect(forwarded('meetup.cancelled', 'u_mh3')).toHaveLength(0);
    expect((await api('POST', `/v1/meetups/${id}/cancel`, 'u_mh3')).body.status).toBe('cancelled');
  });

  it('host cancellation cancels the meetup and guests can no longer accept', async () => {
    await provision('u_mh4', 'u_mg6');
    const created = await createMeetup('u_mh4', ['u_mg6']);
    const id = created.body.id as string;
    expect((await api('POST', `/v1/meetups/${id}/cancel`, 'u_mh4')).body.status).toBe('cancelled');
    expect((await api('POST', `/v1/meetups/${id}/accept`, 'u_mg6')).status).toBe(409);
    expect(forwarded('meetup.cancelled', 'u_mg6')).toEqual([expect.objectContaining({ actor_subject: 'u_mh4', body: '{actor} cancelled the meetup.', data: { meetup_id: id, status: 'cancelled', route: `/meetup/${id}` } })]);
  });

  it('an accepted guest leaves and the meetup remains confirmed while another guest remains', async () => {
    await provision('u_mh5', 'u_mg7', 'u_mg8');
    const created = await createMeetup('u_mh5', ['u_mg7', 'u_mg8']);
    const id = created.body.id as string;
    await api('POST', `/v1/meetups/${id}/accept`, 'u_mg7');
    const left = await api('POST', `/v1/meetups/${id}/leave`, 'u_mg7');
    expect(left.body.status).toBe('confirmed');
    expect((left.body.participants as { user_id: string; status: string }[]).find((p) => p.user_id === 'u_mg7')?.status).toBe('declined');
  });

  it('a blocked user cannot be invited in either direction', async () => {
    await provision('u_bh1', 'u_bg1', 'u_bh2', 'u_bg2');
    await api('POST', '/v1/users/u_bg1/block', 'u_bh1');
    await api('POST', '/v1/users/u_bh2/block', 'u_bg2');
    expect((await createMeetup('u_bh1', ['u_bg1'])).body.code).toBe('meetup_blocked');
    expect((await createMeetup('u_bh2', ['u_bg2'])).body.code).toBe('meetup_blocked');
  });

  it('a block created after an invite hides it and prevents acceptance', async () => {
    await provision('u_bh3', 'u_bg3');
    const created = await createMeetup('u_bh3', ['u_bg3']);
    const id = created.body.id as string;
    expect(forwarded('meetup.invited', 'u_bg3')).toEqual([expect.objectContaining({ actor_subject: 'u_bh3', kind: 'meetup.invited', data: { meetup_id: id, route: `/meetup/${id}` } })]);
    await api('POST', '/v1/users/u_bh3/block', 'u_bg3');
    expect((await api('GET', '/v1/meetups', 'u_bg3')).body.meetups).toHaveLength(0);
    expect((await api('GET', `/v1/meetups/${id}`, 'u_bg3')).status).toBe(404);
    expect((await api('POST', `/v1/meetups/${id}/accept`, 'u_bg3')).status).toBe(404);
    expect((await api('POST', `/v1/meetups/${id}/cancel`, 'u_bh3')).body.status).toBe('cancelled');
  });

  it('rejects a starts_at value in the past', async () => {
    await provision('u_mh6', 'u_mg9');
    const created = await createMeetup('u_mh6', ['u_mg9'], { starts_at: new Date(Date.now() - 60_000).toISOString() });
    expect(created.status).toBe(422);
    expect(created.body.detail).toContain('future');
  });

  it('rejects inviting yourself', async () => {
    await provision('u_mh7');
    const created = await createMeetup('u_mh7', ['u_mh7']);
    expect(created.status).toBe(422);
    expect(created.body.detail).toContain('yourself');
  });

  it('returns 404 to a non-participant requesting meetup details', async () => {
    await provision('u_mh8', 'u_mg10', 'u_mstranger');
    const created = await createMeetup('u_mh8', ['u_mg10']);
    expect((await api('GET', `/v1/meetups/${created.body.id}`, 'u_mstranger')).status).toBe(404);
  });

  it('derives completed on read after starts_at passes without changing stored status', async () => {
    await provision('u_mh9', 'u_mg11');
    const created = await createMeetup('u_mh9', ['u_mg11']);
    const id = created.body.id as string;
    await api('POST', `/v1/meetups/${id}/accept`, 'u_mg11');
    await sql(`UPDATE meetups SET starts_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect((await api('GET', `/v1/meetups/${id}`, 'u_mh9')).body.status).toBe('completed');
    const stored = await sql<{ status: string }>(`SELECT status FROM meetups WHERE id = $1`, [id]);
    expect(stored[0]!.status).toBe('confirmed');
    expect((await api('POST', `/v1/meetups/${id}/cancel`, 'u_mh9')).status).toBe(409);
  });

  it('check-in visibility conforms to the four-viewer checklist', async () => {
    await provision('u_check_h1', 'u_check_g1', 'u_check_g2', 'u_check_s1', 'u_check_b1');
    const created = await createMeetup('u_check_h1', ['u_check_g1', 'u_check_g2']);
    const id = created.body.id as string;
    
    await sql(`UPDATE meetups SET starts_at = now() WHERE id = $1`, [id]);
    
    // Guest 1 checks in
    await api('POST', `/v1/meetups/${id}/check-in`, 'u_check_g1');
    
    // Viewer 1: Guest 1 (checked in) sees their own my_check_in_at and checked_in: true for themselves.
    const resG1 = await api('GET', `/v1/meetups/${id}`, 'u_check_g1');
    expect(typeof resG1.body.my_check_in_at).toBe('string');
    const partsG1 = resG1.body.participants as any[];
    expect(partsG1.find(p => p.user_id === 'u_check_g1').checked_in).toBe(true);
    expect(partsG1.find(p => p.user_id === 'u_check_g2').checked_in).toBe(false);
    
    // Viewer 2: Guest 2 (not checked in) sees null for my_check_in_at, but sees Guest 1's checked_in.
    const resG2 = await api('GET', `/v1/meetups/${id}`, 'u_check_g2');
    expect(resG2.body.my_check_in_at).toBe(null);
    const partsG2 = resG2.body.participants as any[];
    expect(partsG2.find(p => p.user_id === 'u_check_g1').checked_in).toBe(true);
    expect(partsG2.find(p => p.user_id === 'u_check_g2').checked_in).toBe(false);
    
    // Host checks in. Reopening (a second check-in) works.
    await api('POST', `/v1/meetups/${id}/check-in`, 'u_check_h1');
    await api('POST', `/v1/meetups/${id}/check-in`, 'u_check_h1');
    const resH1 = await api('GET', `/v1/meetups/${id}`, 'u_check_h1');
    expect(typeof resH1.body.my_check_in_at).toBe('string');
    const partsH1 = resH1.body.participants as any[];
    expect(partsH1.find(p => p.user_id === 'u_check_h1').checked_in).toBe(true);
    
    // Viewer 3: Stranger gets 404.
    const resS1 = await api('GET', `/v1/meetups/${id}`, 'u_check_s1');
    expect(resS1.status).toBe(404);
    
    // Viewer 4: Blocked pair gets 404.
    await api('POST', '/v1/users/u_check_b1/block', 'u_check_h1');
    const createdBlocked = await createMeetup('u_check_h1', ['u_check_g1']);
    const resB1 = await api('GET', `/v1/meetups/${createdBlocked.body.id as string}`, 'u_check_b1');
    expect(resB1.status).toBe(404);
  });
});
