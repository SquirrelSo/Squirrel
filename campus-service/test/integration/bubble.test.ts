import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { api, app, HAS_DB, sql, tokenFor, useTestApp } from './setup.js';
import { assertNoCoordinates, fakeSocial } from './fake-social.js';
import { config } from '../../src/config.js';
import { cellCentre, cellFor } from '../../src/bubble/cells.js';
import { resetBubbleThrottle } from '../../src/bubble/service.js';
import { onRealtime, type RealtimeEvent } from '../../src/realtime/bus.js';
import { invalidateUserCache } from '../../src/users/repo.js';
import { runSweeps } from '../../src/sweeper.js';
import { xyToLatLng } from '../helpers.js';

const C = cellFor(config.campus.centerLat, config.campus.centerLng);
/** Centre of the cell dx/dy cells away from the campus-centre cell. */
const at = (dx: number, dy: number) => cellCentre(C.ix + dx, C.iy + dy);

async function openUser(id: string) {
  await api('GET', '/v1/me', id);
  await sql(`UPDATE users SET open_to_meet = true, open_to_meet_until = now() + interval '12 hours' WHERE id = $1`, [id]);
  invalidateUserCache(id);
}
async function join(id: string, pos: { lat: number; lng: number }, extra: Record<string, unknown> = {}) {
  return api('POST', '/v1/bubble/join', id, { ...pos, accuracy_m: 12, ...extra });
}
async function leave(id: string) {
  const r = await app.inject({ method: 'POST', url: '/v1/bubble/leave', headers: { authorization: `Bearer ${await tokenFor(id)}` } });
  return { status: r.statusCode, body: r.body };
}
const ids = (r: { body: Record<string, any> }) => (r.body.items as any[]).map((i) => i.person.user_id);

const events: RealtimeEvent[] = [];
const bubbleEvents = (type?: string) => events.filter((e) => e.type.startsWith('bubble.') && (!type || e.type === type)) as (RealtimeEvent & { user_ids: string[]; data: any })[];

describe.skipIf(!HAS_DB)('bubble (integration)', () => {
  useTestApp();
  const social = fakeSocial();
  let off: () => void;

  beforeAll(async () => {
    await social.start();
    off = onRealtime((e) => events.push(e));
  });
  afterAll(async () => { off(); await social.stop(); });
  beforeEach(() => { events.length = 0; resetBubbleThrottle(); });
  afterEach(() => { vi.restoreAllMocks(); social.off(); social.reset(); });

  it('every bubble and discover route needs a signed-in user (401)', async () => {
    const routes: ['GET' | 'POST', string][] = [
      ['POST', '/v1/bubble/join'], ['POST', '/v1/bubble/leave'], ['GET', '/v1/bubble'], ['GET', '/v1/bubble/nearby'],
      ['GET', '/v1/discover'], ['GET', '/v1/discover/nearby'], ['GET', '/v1/discover/active'], ['GET', '/v1/discover/challenges'],
      ['GET', '/v1/discover/crews'], ['GET', '/v1/discover/zones'],
    ];
    for (const [m, url] of routes) {
      const r = await api(m, url, null, m === 'POST' ? { lat: at(0, 0).lat, lng: at(0, 0).lng } : undefined);
      expect(r.status, `${m} ${url}`).toBe(401);
      expect(r.body.code).toBe('unauthorized');
    }
  });

  it('invalid payloads and queries are 422', async () => {
    await openUser('u_bv_1');
    await openUser('u_bv_2');
    const bad = [
      {}, { lat: 'x', lng: 1 }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { ...at(0, 0), activity_type: 'swim' },
      { ...at(0, 0), accuracy_m: -1 }, { ...at(0, 0), user_id: 'someone' },
    ];
    // (two users: join is limited to 6 requests a minute per user)
    for (const [i, b] of bad.entries()) expect((await api('POST', '/v1/bubble/join', i < 4 ? 'u_bv_1' : 'u_bv_2', b)).status, JSON.stringify(b)).toBe(422);
    for (const q of ['state=far', 'limit=0', 'limit=51', 'cursor=@@@', 'foo=1']) expect((await api('GET', `/v1/bubble/nearby?${q}`, 'u_bv_1')).status, q).toBe(422);
    expect((await api('POST', '/v1/bubble/leave', 'u_bv_1', { user_id: 'x' })).status).toBe(422);
  });

  it('Open to Meet is required to join (409), and a lapsed one counts as off', async () => {
    await api('GET', '/v1/me', 'u_otm_1');
    const r = await join('u_otm_1', at(0, 0));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('open_to_meet_required');
    await sql(`UPDATE users SET open_to_meet = true, open_to_meet_until = now() - interval '1 minute' WHERE id = 'u_otm_1'`);
    invalidateUserCache('u_otm_1');
    expect((await join('u_otm_1', at(0, 0))).body.code).toBe('open_to_meet_required');
    expect((await sql(`SELECT 1 FROM bubble_members WHERE user_id = 'u_otm_1'`)).length).toBe(0);
  });

  it('join stores only a coarse cell and zone, never coordinates, and is an idempotent upsert', async () => {
    const cols = (await sql<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'bubble_members'`)).map((c) => c.column_name).sort();
    expect(cols).toEqual(['activity_type', 'cell', 'expires_at', 'joined_at', 'refreshed_at', 'user_id', 'zone_id']);

    await openUser('u_bj_1');
    const lib = xyToLatLng(280, 110); // inside the Library zone
    const r = await join('u_bj_1', lib, { activity_type: 'walk' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: true, in_bubble: true, zone: { id: 'library', name: 'Library' }, activity_type: 'walk' });
    assertNoCoordinates(r.body);
    expect(JSON.stringify(r.body)).not.toContain(String(lib.lat).slice(0, 7));
    expect(JSON.stringify(r.body)).not.toContain(String(lib.lng).slice(0, 7));
    const ttl = Date.parse(r.body.expires_at as string) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 5_000);

    const [row] = await sql<{ cell: string; zone_id: string; joined_at: string }>(`SELECT cell, zone_id, joined_at FROM bubble_members WHERE user_id = 'u_bj_1'`);
    expect(row!.cell).toBe(cellFor(lib.lat, lib.lng).key);
    expect(row!.zone_id).toBe('library');
    // presence (exact fixes) is untouched by the bubble
    expect((await sql(`SELECT 1 FROM presence WHERE user_id = 'u_bj_1'`)).length).toBe(0);

    const again = await join('u_bj_1', lib);
    expect(again.status).toBe(200);
    expect(again.body.activity_type).toBe('walk'); // omitted → kept
    const rows = await sql<{ joined_at: string }>(`SELECT joined_at FROM bubble_members WHERE user_id = 'u_bj_1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.joined_at).toBe(row!.joined_at);
    expect((await leave('u_bj_1')).status).toBe(204);
  });

  it('off campus is refused like presence and leaves the bubble', async () => {
    await openUser('u_off_1');
    await join('u_off_1', at(0, 0));
    const r = await api('POST', '/v1/bubble/join', 'u_off_1', { lat: 22.5726, lng: 88.3639 }); // Kolkata, ~45 km
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: false, reason: 'off_campus', in_bubble: false });
    expect((await sql(`SELECT 1 FROM bubble_members WHERE user_id = 'u_off_1'`)).length).toBe(0);
  });

  it('nearby lists the 3×3 neighbourhood only, with buckets and states, never coordinates', async () => {
    for (const u of ['u_n_a', 'u_n_b', 'u_n_c', 'u_n_d']) await openUser(u);
    await join('u_n_a', at(-8, -8), { activity_type: 'run' });
    await join('u_n_b', at(-7, -7), { activity_type: 'run' }); // diagonal neighbour
    await join('u_n_c', at(-6, -8));                          // two cells east: outside A's 3×3
    await join('u_n_d', at(-8, -8));                          // same cell

    const a = await api('GET', '/v1/bubble/nearby', 'u_n_a');
    expect(a.status).toBe(200);
    assertNoCoordinates(a.body);
    expect(ids(a).sort()).toEqual(['u_n_b', 'u_n_d']);
    const d = (a.body.items as any[]).find((i) => i.person.user_id === 'u_n_d');
    const b = (a.body.items as any[]).find((i) => i.person.user_id === 'u_n_b');
    expect(d.proximity).toBe('very_close');
    expect(b.proximity).toBe('nearby');
    expect(b.states).toEqual(expect.arrayContaining(['nearby', 'active_nearby', 'same_campus', 'same_activity']));
    expect(d.states).toContain('nearby');
    expect(d.states).not.toContain('active_nearby');
    expect(b.person).toMatchObject({ user_id: 'u_n_b', level: expect.any(Number), xp: expect.any(Number) });
    expect(b.activity).toEqual({ type: 'run', started_at: null });
    expect(ids(a)[0]).toBe('u_n_d'); // same cell first

    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_n_c'))).toEqual(['u_n_b']); // C sees B, not A or D

    const state = await api('GET', '/v1/bubble', 'u_n_a');
    expect(state.body.counts).toEqual({ nearby: 2, active_nearby: 1, same_zone: 0, same_activity: 1 });
    assertNoCoordinates(state.body);

    expect(ids(await api('GET', '/v1/bubble/nearby?state=active_nearby', 'u_n_a'))).toEqual(['u_n_b']);
    expect(ids(await api('GET', '/v1/bubble/nearby?state=same_zone', 'u_n_a'))).toEqual([]);
  });

  it('same_zone uses the zone found on join', async () => {
    for (const u of ['u_z_a', 'u_z_b']) await openUser(u);
    await join('u_z_a', xyToLatLng(250, 80));
    await join('u_z_b', xyToLatLng(310, 150));
    const r = await api('GET', '/v1/bubble/nearby?state=same_zone', 'u_z_a');
    expect(ids(r)).toEqual(['u_z_b']);
    expect((r.body.items as any[])[0].zone).toEqual({ id: 'library', name: 'Library' });
  });

  it('keyset pagination walks every member once', async () => {
    const people = ['u_p_0', 'u_p_1', 'u_p_2', 'u_p_3', 'u_p_4'];
    await openUser('u_p_me');
    await join('u_p_me', at(-8, 8));
    for (const [i, u] of people.entries()) { await openUser(u); await join(u, at(-8 + (i % 2), 8)); }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r: any = await api('GET', `/v1/bubble/nearby?limit=2${cursor ? `&cursor=${cursor}` : ''}`, 'u_p_me');
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...ids(r));
      cursor = r.body.next_cursor;
      if (cursor) expect(cursor).not.toContain('u_p_'); // the cursor never carries a user id
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(people);
  });

  it('blocked users never appear, in either direction, and are not counted', async () => {
    for (const u of ['u_b_a', 'u_b_b', 'u_b_c']) await openUser(u);
    await join('u_b_a', at(-4, -8));
    await join('u_b_b', at(-4, -8));
    await join('u_b_c', at(-3, -8));
    expect((await api('POST', '/v1/users/u_b_a/block', 'u_b_b')).status).toBe(200); // B blocks A (local)
    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_b_a'))).toEqual(['u_b_c']);
    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_b_b'))).toEqual(['u_b_c']);
    expect((await api('GET', '/v1/bubble', 'u_b_a')).body.counts.nearby).toBe(1);

    social.on(); // a block that only Social knows about
    social.state.blocks.set('u_b_c', ['u_b_a']);
    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_b_a'))).toEqual([]);
    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_b_c'))).toEqual(['u_b_b']); // C blocked only A
  });

  it('Social unreachable: nearby fails closed (empty + blocks_unreachable)', async () => {
    for (const u of ['u_su_a', 'u_su_b']) await openUser(u);
    await join('u_su_a', at(0, -8));
    await join('u_su_b', at(0, -8));
    social.on();
    social.state.mode = 'error';
    const r = await api('GET', '/v1/bubble/nearby', 'u_su_a');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.hidden_reason).toBe('blocks_unreachable');
    const s = await api('GET', '/v1/bubble', 'u_su_a');
    expect(s.body.counts.nearby).toBe(0);
    expect(s.body.hidden_reason).toBe('blocks_unreachable');
  });

  it('a lapsed Open to Meet hides a member at once, before any sweep, and the sweep removes them', async () => {
    for (const u of ['u_l_a', 'u_l_b']) await openUser(u);
    await join('u_l_a', at(4, -8));
    await join('u_l_b', at(4, -8));
    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_l_a'))).toEqual(['u_l_b']);
    await sql(`UPDATE users SET open_to_meet_until = now() - interval '1 second' WHERE id = 'u_l_b'`);
    invalidateUserCache('u_l_b');
    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_l_a'))).toEqual([]);
    expect((await api('GET', '/v1/bubble', 'u_l_b')).body).toMatchObject({ in_bubble: false, hidden_reason: 'open_to_meet_off' });
    await runSweeps();
    expect((await sql(`SELECT 1 FROM bubble_members WHERE user_id = 'u_l_b'`)).length).toBe(0);
  });

  it('turning Open to Meet off leaves the bubble', async () => {
    await openUser('u_o_a');
    await join('u_o_a', at(8, -8));
    await sql(`INSERT INTO activities (user_id, activity_type, verification_status, started_at) VALUES ('u_o_a', 'walk', 'VERIFIED', now() - interval '3 hours')`);
    expect((await api('PUT', '/v1/me/open-to-meet', 'u_o_a', { enabled: false })).status).toBe(200);
    expect((await sql(`SELECT 1 FROM bubble_members WHERE user_id = 'u_o_a'`)).length).toBe(0);
  });

  it('leave deletes the membership (204) and the member disappears for others', async () => {
    for (const u of ['u_lv_a', 'u_lv_b']) await openUser(u);
    await join('u_lv_a', at(-8, -4));
    await join('u_lv_b', at(-8, -4));
    events.length = 0; resetBubbleThrottle();
    const r = await app.inject({ method: 'POST', url: '/v1/bubble/leave', headers: { authorization: `Bearer ${await tokenFor('u_lv_b')}` } });
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
    expect((await api('GET', '/v1/bubble', 'u_lv_b')).body).toMatchObject({ in_bubble: false, zone: null, expires_at: null });
    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_lv_a'))).toEqual([]);
    const left = bubbleEvents('bubble.user_left');
    expect(left).toHaveLength(1);
    expect(left[0]!.user_ids).toEqual(['u_lv_a']);
    expect(left[0]!.data.person.user_id).toBe('u_lv_b');
    // leaving twice is fine
    expect((await app.inject({ method: 'POST', url: '/v1/bubble/leave', headers: { authorization: `Bearer ${await tokenFor('u_lv_b')}` } })).statusCode).toBe(204);
  });

  it('expiry: an expired member is out at once; the sweep deletes the row and tells neighbours', async () => {
    for (const u of ['u_e_a', 'u_e_b']) await openUser(u);
    await join('u_e_a', at(-4, -4));
    await join('u_e_b', at(-3, -4));
    await sql(`UPDATE bubble_members SET expires_at = now() - interval '1 second' WHERE user_id = 'u_e_b'`);
    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_e_a'))).toEqual([]);
    expect((await api('GET', '/v1/bubble', 'u_e_b')).body.in_bubble).toBe(false);
    events.length = 0; resetBubbleThrottle();
    const swept = await runSweeps();
    expect(swept.bubble).toBeGreaterThanOrEqual(1);
    expect((await sql(`SELECT 1 FROM bubble_members WHERE user_id = 'u_e_b'`)).length).toBe(0);
    const left = bubbleEvents('bubble.user_left').filter((e) => e.data.person.user_id === 'u_e_b');
    expect(left.map((e) => e.user_ids[0])).toEqual(['u_e_a']);
    // rejoining after expiry is a fresh join (outside the per-pair throttle window)
    events.length = 0; resetBubbleThrottle();
    await join('u_e_b', at(-3, -4));
    expect(bubbleEvents('bubble.user_joined').map((e) => e.user_ids[0])).toEqual(['u_e_a']);
  });

  it('realtime: joined goes only to unblocked neighbours, payload has no coordinates, and it is throttled per pair', async () => {
    for (const u of ['u_r_a', 'u_r_b', 'u_r_c', 'u_r_d']) await openUser(u);
    await join('u_r_b', at(4, -4));
    await join('u_r_c', at(7, -4)); // not a neighbour of A
    await join('u_r_d', at(4, -3));
    await api('POST', '/v1/users/u_r_a/block', 'u_r_d'); // D blocked A
    events.length = 0; resetBubbleThrottle();

    await join('u_r_a', at(5, -4), { activity_type: 'walk' });
    const joined = bubbleEvents('bubble.user_joined');
    expect(joined.map((e) => e.user_ids)).toEqual([['u_r_b']]);
    const data = joined[0]!.data;
    expect(data).toMatchObject({ person: { user_id: 'u_r_a' }, state: 'joined', proximity: 'nearby', activity: { type: 'walk' } });
    expect(data).toHaveProperty('zone');
    assertNoCoordinates(data);

    // An activity change within 60 s of the last event to B is dropped…
    events.length = 0;
    await join('u_r_a', at(5, -4), { activity_type: null });
    expect(bubbleEvents()).toHaveLength(0);
    // …and goes out once the window has passed.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await join('u_r_a', at(5, -4), { activity_type: 'run' });
    const started = bubbleEvents('bubble.activity_started');
    expect(started.map((e) => e.user_ids)).toEqual([['u_r_b']]);
    expect(started[0]!.data.activity).toEqual({ type: 'run', started_at: null });
    vi.restoreAllMocks();
    // ended
    events.length = 0; resetBubbleThrottle();
    await join('u_r_a', at(5, -4), { activity_type: null });
    expect(bubbleEvents('bubble.activity_ended').map((e) => e.user_ids)).toEqual([['u_r_b']]);
  });

  it('realtime: moving cells sends left to old-only neighbours and joined to new-only ones', async () => {
    for (const u of ['u_m_a', 'u_m_old', 'u_m_new', 'u_m_both']) await openUser(u);
    await join('u_m_old', at(-8, 4));
    await join('u_m_new', at(-5, 4));
    await join('u_m_both', at(-7, 4));
    await join('u_m_a', at(-8, 4));
    events.length = 0; resetBubbleThrottle();
    await join('u_m_a', at(-6, 4));
    expect(bubbleEvents('bubble.user_left').map((e) => e.user_ids[0])).toEqual(['u_m_old']);
    expect(bubbleEvents('bubble.user_joined').map((e) => e.user_ids[0])).toEqual(['u_m_new']);
  });

  it('realtime: starting a recorded activity tells bubble neighbours (activity_started)', async () => {
    for (const u of ['u_ra_a', 'u_ra_b']) await openUser(u);
    await join('u_ra_a', at(4, 4));
    await join('u_ra_b', at(4, 4));
    await api('PUT', '/v1/map/presence', 'u_ra_a', at(4, 4));
    events.length = 0; resetBubbleThrottle();
    const r = await api('POST', '/v1/activities', 'u_ra_a', { type: 'run', started_at: new Date().toISOString() });
    expect(r.status).toBe(201);
    const started = bubbleEvents('bubble.activity_started');
    expect(started.map((e) => e.user_ids)).toEqual([['u_ra_b']]);
    expect(started[0]!.data.activity.type).toBe('run');
    // The neighbour now sees an active member
    expect((await api('GET', '/v1/bubble/nearby?state=active_nearby', 'u_ra_b')).body.items).toHaveLength(1);
    resetBubbleThrottle(); events.length = 0;
    await api('POST', `/v1/activities/${r.body.activity_id}/finish`, 'u_ra_a', {});
    expect(bubbleEvents('bubble.activity_ended').map((e) => e.user_ids)).toEqual([['u_ra_b']]);
  });

  it('realtime over the socket: the bubble topic is on after auth and frames reach only the neighbour', async () => {
    for (const u of ['u_ws_a', 'u_ws_b']) await openUser(u);
    await join('u_ws_b', at(8, 4));
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/realtime`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const frames: { type: string; data: any }[] = [];
    ws.on('message', (m: Buffer) => frames.push(JSON.parse(String(m))));
    const waitFor = async (type: string) => { for (let i = 0; i < 100 && !frames.some((f) => f.type === type); i++) await new Promise((r) => setTimeout(r, 20)); return frames.find((f) => f.type === type); };
    ws.send(JSON.stringify({ type: 'auth', token: await tokenFor('u_ws_b') }));
    await waitFor('auth.ok');
    resetBubbleThrottle();
    await join('u_ws_a', at(8, 5));
    const f = await waitFor('bubble.user_joined');
    expect(f?.data.person.user_id).toBe('u_ws_a');
    assertNoCoordinates(f?.data);
    ws.terminate();
  });

  it('notification: joining a bubble with ≥3 other visible members notifies the joiner once per 6 h window', async () => {
    social.on();
    for (const u of ['u_nt_a', 'u_nt_1', 'u_nt_2', 'u_nt_3']) await openUser(u);
    for (const u of ['u_nt_1', 'u_nt_2']) await join(u, at(0, 8));
    await join('u_nt_a', at(0, 8));
    expect(social.state.notifications.filter((n) => n.user_subject === 'u_nt_a')).toHaveLength(0); // only 2 others

    await join('u_nt_3', at(0, 9));
    await leave('u_nt_a');
    await join('u_nt_a', at(0, 8));
    const mine = social.state.notifications.filter((n) => n.user_subject === 'u_nt_a');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'bubble.activity', data: { route: '/bubble' } });
    expect(String(mine[0]!.dedupe_key)).toMatch(/^campus:bubble\.activity:/);
    assertNoCoordinates(mine[0]);
    // u_nt_3 joined with 3 visible others too
    expect(social.state.notifications.filter((n) => n.user_subject === 'u_nt_3')).toHaveLength(1);

    await leave('u_nt_a');
    await join('u_nt_a', at(0, 8));
    expect(social.state.notifications.filter((n) => n.user_subject === 'u_nt_a')).toHaveLength(1); // still once
  });

  it('IDOR: there is no way to read another user\'s bubble state', async () => {
    for (const u of ['u_id_a', 'u_id_b']) await openUser(u);
    await join('u_id_b', xyToLatLng(280, 110), { activity_type: 'run' });
    await join('u_id_a', at(4, 8));
    expect((await api('GET', '/v1/bubble?user_id=u_id_b', 'u_id_a')).status).toBe(422);
    expect((await api('GET', '/v1/bubble/u_id_b', 'u_id_a')).status).toBe(404);
    const mine = await api('GET', '/v1/bubble', 'u_id_a');
    expect(mine.body).toMatchObject({ in_bubble: true, zone: null, activity_type: null });
    // and B is not a neighbour, so A's nearby list doesn't contain B either
    expect(ids(await api('GET', '/v1/bubble/nearby', 'u_id_a'))).not.toContain('u_id_b');
  });

  it('join is rate limited to 6 per minute', async () => {
    await openUser('u_rl_a');
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await join('u_rl_a', at(8, 8))).status);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes[6]).toBe(429);
    const limited = await join('u_rl_a', at(8, 8));
    expect(limited.body.code).toBe('rate_limited');
  });
});
