import { describe, expect, it } from 'vitest';
import { api, HAS_DB, sql, submitAndVerify, useTestApp } from './setup.js';
import { sweepRect, trackAlong } from '../helpers.js';

const sweep = () => trackAlong([[-100, -100], [75, 45], ...sweepRect(70, 40, 195, 150, 20), [300, 300], [-100, -100]], 3.2);

async function active(userId: string, activityAt?: Date) {
  const activityId = await submitAndVerify(userId, sweep());
  await api('PUT', '/v1/me/open-to-meet', userId, { enabled: true });
  if (activityAt) await sql(`UPDATE activities SET started_at = $2 WHERE id = $1`, [activityId, activityAt]);
  return activityId;
}

async function localHourAgo(hour: number) {
  const date = new Date(Date.now() - 24 * 60 * 60 * 1000);
  date.setUTCHours(hour - 6, 30, 0, 0); // Asia/Kolkata is UTC+05:30.
  return date;
}

async function suggestions(userId: string) {
  const result = await api('GET', '/v1/squirrel-dates/suggestions', userId);
  expect(result.status).toBe(200);
  return result.body.suggestions as { person: { user_id: string; activity: string }; zone: { id: string }; suggested_date: string; time_slot: string }[];
}

async function allTableCounts() {
  const tables = await sql<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const entries = await Promise.all(tables.map(async ({ table_name }) => {
    const safeName = table_name.replaceAll('"', '""');
    const [{ count }] = await sql<{ count: number }>(`SELECT count(*)::int AS count FROM public."${safeName}"`);
    return [table_name, count] as const;
  }));
  return Object.fromEntries(entries);
}

describe.skipIf(!HAS_DB)('Squirrel Dates suggestions (integration)', () => {
  useTestApp();

  it('two users sharing a zone produce a date suggestion for that zone', async () => {
    await active('cs5_share_me');
    await active('cs5_share_other');
    const result = await suggestions('cs5_share_me');
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({
      person: expect.objectContaining({ user_id: 'cs5_share_other' }),
      zone: expect.objectContaining({ id: 'cc1' }),
    })]));
  });

  it('a block in either direction suppresses the suggestion', async () => {
    await active('cs5_block_me');
    await active('cs5_blocked_by_me');
    await active('cs5_blocking_me');
    await api('POST', '/v1/users/cs5_blocked_by_me/block', 'cs5_block_me');
    await api('POST', '/v1/users/cs5_block_me/block', 'cs5_blocking_me');
    const result = await suggestions('cs5_block_me');
    expect(result.map((item) => item.person.user_id)).not.toEqual(expect.arrayContaining(['cs5_blocked_by_me', 'cs5_blocking_me']));
  });

  it('a user with open_to_meet false does not receive a suggestion', async () => {
    await active('cs5_consent_me');
    await active('cs5_consent_other');
    await api('PUT', '/v1/me/open-to-meet', 'cs5_consent_other', { enabled: false });
    expect((await suggestions('cs5_consent_me')).map((item) => item.person.user_id)).not.toContain('cs5_consent_other');
  });

  it('an expired open_to_meet window does not receive a suggestion', async () => {
    await active('cs5_expiry_me');
    await active('cs5_expiry_other');
    await sql(`UPDATE users SET open_to_meet_until = now() - interval '1 second' WHERE id = $1`, ['cs5_expiry_other']);
    expect((await suggestions('cs5_expiry_me')).map((item) => item.person.user_id)).not.toContain('cs5_expiry_other');
  });

  it('an unverified activity does not produce a suggestion', async () => {
    await active('cs5_unverified_me');
    await active('cs5_unverified_other');
    await sql(`UPDATE activities SET verification_status = 'PENDING' WHERE user_id = $1`, ['cs5_unverified_other']);
    expect((await suggestions('cs5_unverified_me')).map((item) => item.person.user_id)).not.toContain('cs5_unverified_other');
  });

  it('a banned user does not produce a suggestion', async () => {
    await active('cs5_banned_me');
    await active('cs5_banned_other');
    await sql(`UPDATE users SET is_banned = true WHERE id = $1`, ['cs5_banned_other']);
    expect((await suggestions('cs5_banned_me')).map((item) => item.person.user_id)).not.toContain('cs5_banned_other');
  });

  it('the serialized suggestion has no activity timestamp, coordinates or per-user count', async () => {
    await active('cs5_private_me');
    await active('cs5_private_other');
    const result = await api('GET', '/v1/squirrel-dates/suggestions', 'cs5_private_me');
    const json = JSON.stringify(result.body);
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(json).not.toMatch(/"(?:lat|lng|latitude|longitude|geometry|coordinates|recorded_at|started_at|created_at|updated_at)"/i);
    expect(json).not.toMatch(/"(?:activity_count|distinct_users|per_user_count|count)"/i);
    expect(json).toMatch(/"suggested_date":"\d{4}-\d{2}-\d{2}"/);
  });

  it('uses the fixed default time when no zone hour reaches three distinct users', async () => {
    await sql(`UPDATE activities SET started_at = now() - interval '31 days'`);
    await active('000_cs5_fallback_me');
    await active('000_cs5_fallback_other');
    const result = await suggestions('000_cs5_fallback_me');
    expect(result.find((item) => item.person.user_id === '000_cs5_fallback_other')?.time_slot).toBe('18:00–19:00');
  });

  it('suggests the most active supported zone hour only after three distinct users contribute', async () => {
    const at = await localHourAgo(21);
    await sql(`UPDATE activities SET started_at = $1`, [at]);
    await active('000_cs5_hour_me', at);
    await active('000_cs5_hour_other', at);
    await active('000_cs5_hour_third', at);
    const result = await suggestions('000_cs5_hour_me');
    expect(result.find((item) => item.person.user_id === '000_cs5_hour_other')?.time_slot).toBe('21:00–22:00');
  });

  it('caps the number of suggestions at ten', async () => {
    const mine = await active('cs5_cap_me');
    const other = await active('cs5_cap_other');
    await sql(
      `INSERT INTO qualification_results (activity_id, user_id, zone_id, status, verified, interaction)
       SELECT $1, $2, z.id, 'NOT_QUALIFIED', true, 'visited' FROM zones z WHERE z.is_active
       ON CONFLICT (activity_id, zone_id) DO NOTHING`,
      [mine, 'cs5_cap_me'],
    );
    await sql(
      `INSERT INTO qualification_results (activity_id, user_id, zone_id, status, verified, interaction)
       SELECT $1, $2, z.id, 'NOT_QUALIFIED', true, 'visited' FROM zones z WHERE z.is_active
       ON CONFLICT (activity_id, zone_id) DO NOTHING`,
      [other, 'cs5_cap_other'],
    );
    const result = await api('GET', '/v1/squirrel-dates/suggestions', 'cs5_cap_me');
    expect((result.body.suggestions as unknown[]).length).toBe(10);
    expect(result.body.cap).toEqual({ suggestions: 10 });
  });

  it('repeated calls do not add or remove rows in any table', async () => {
    await active('cs5_readonly_me');
    await active('cs5_readonly_other');
    await api('GET', '/v1/me', 'cs5_readonly_me'); // finish auth's just-in-time provisioning before counting.
    const before = await allTableCounts();
    await api('GET', '/v1/squirrel-dates/suggestions', 'cs5_readonly_me');
    await api('GET', '/v1/squirrel-dates/suggestions', 'cs5_readonly_me');
    expect(await allTableCounts()).toEqual(before);
  });
});
