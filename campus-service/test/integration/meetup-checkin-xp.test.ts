/** meetup_checkin XP (contract §1): 25 XP, source campus, once per meetup per person, after ≥2 check-ins. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, HAS_DB, resetRunFakeStats, runFakeState, runFakeStats, sql, useTestApp } from './setup.js';
import { configureRunBridge, runSettings } from '../../src/run/index.js';

async function seedUser(id: string) {
  await sql(`INSERT INTO users (id, display_name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [id]);
}
async function meetup(host: string, guests: string[]) {
  for (const u of [host, ...guests]) await seedUser(u);
  const r = await api('POST', '/v1/meetups', host, { place_text: 'Chai stall', starts_at: new Date(Date.now() + 360_000).toISOString(), invitee_ids: guests });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
const checkIn = (id: string, user: string) => api('POST', `/v1/meetups/${id}/check-in`, user, {});
const settle = () => new Promise((r) => setTimeout(r, 150));

describe.skipIf(!HAS_DB)('meetup check-in XP (integration)', () => {
  useTestApp();
  beforeEach(() => {
    resetRunFakeStats();
    runFakeState.offline = false;
    const s = runSettings();
    if (s) configureRunBridge({ url: s.url, token: s.token });
  });

  it('nothing for the first check-in; both get 25 at the second; each later one gets its own; replays add nothing', async () => {
    const id = await meetup('u_mx_host', ['u_mx_g1', 'u_mx_g2']);
    expect((await checkIn(id, 'u_mx_g1')).status).toBe(200);
    await settle();
    expect(runFakeStats.awardBodies).toHaveLength(0);

    expect((await checkIn(id, 'u_mx_host')).status).toBe(200);
    await vi.waitFor(() => expect(runFakeStats.awardBodies).toHaveLength(2));
    for (const subject of ['u_mx_g1', 'u_mx_host']) {
      expect(runFakeStats.awardBodies).toContainEqual({ subject, amount: 25, reason: 'meetup_checkin', source: 'campus', idempotency_key: `meetup:${id}:${subject}`, source_id: id });
    }

    expect((await checkIn(id, 'u_mx_g2')).status).toBe(200);
    await vi.waitFor(() => expect(runFakeStats.awardBodies).toHaveLength(3));
    expect(runFakeStats.awardBodies[2]).toMatchObject({ subject: 'u_mx_g2', idempotency_key: `meetup:${id}:u_mx_g2` });

    // replayed check-ins award nothing more
    for (const u of ['u_mx_g1', 'u_mx_host', 'u_mx_g2']) expect((await checkIn(id, u)).status).toBe(200);
    await settle();
    expect(runFakeStats.awardBodies).toHaveLength(3);
    const keys = runFakeStats.awardBodies.map((b) => b.idempotency_key);
    expect(new Set(keys).size).toBe(3);

    // the returned total lands in the read cache (the fake returns amount + 1000)
    await vi.waitFor(async () => expect((await sql(`SELECT xp_total FROM users WHERE id = 'u_mx_g2'`))[0]!.xp_total).toBe(1025));
  });

  it('a meetup where only one person checks in awards nothing', async () => {
    const id = await meetup('u_mx1_host', ['u_mx1_g']);
    expect((await checkIn(id, 'u_mx1_g')).status).toBe(200);
    await settle();
    expect(runFakeStats.awardBodies).toHaveLength(0);
  });

  it('the Run Module being down never affects the check-in', async () => {
    const id = await meetup('u_mx2_host', ['u_mx2_g']);
    runFakeState.offline = true;
    expect((await checkIn(id, 'u_mx2_g')).status).toBe(200);
    const r = await checkIn(id, 'u_mx2_host');
    expect(r.status).toBe(200);
    expect(r.body.meetup_id).toBe(id);
    await settle();
    expect(runFakeStats.awards).toBe(0);
    expect((await sql(`SELECT count(*)::int AS n FROM meetup_participants WHERE meetup_id = $1 AND checked_in_at IS NOT NULL`, [id]))[0]!.n).toBe(2);
  });
});
