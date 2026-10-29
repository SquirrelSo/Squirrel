import { beforeEach, describe, expect, it } from 'vitest';
import { api, HAS_DB, sql, useTestApp } from './setup.js';
import { xyToLatLng } from '../helpers.js';

const PREFIX = 'cs4_heatmap_';
const pointTime = new Date(Date.now() - 60_000).toISOString();

async function addPointActivity(userId: string, status = 'VERIFIED', x = 0, y = 0) {
  const me = await api('GET', '/v1/me', userId);
  expect(me.status).toBe(200);
  const activity = await sql<{ id: string }>(
    `INSERT INTO activities (user_id, activity_type, verification_status, started_at, ended_at, point_count)
     VALUES ($1, 'run', $2, $3, $3, 1) RETURNING id`,
    [userId, status, pointTime],
  );
  const { lat, lng } = xyToLatLng(x, y);
  await sql(
    `INSERT INTO activity_points (activity_id, seq, geom, recorded_at, accuracy_m)
     VALUES ($1, 0, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, 8)`,
    [activity[0]!.id, lng, lat, pointTime],
  );
}

async function heatmap(window = '') {
  return api('GET', `/v1/map/heatmap${window ? `?window=${window}` : ''}`, `${PREFIX}viewer`);
}

describe.skipIf(!HAS_DB)('activity heatmap (integration)', () => {
  useTestApp();

  beforeEach(async () => {
    await sql(`DELETE FROM activities WHERE user_id LIKE $1`, [`${PREFIX}%`]);
    await sql(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}%`]);
  });

  it('returns a cell with activity from three distinct users', async () => {
    await Promise.all(['a', 'b', 'c'].map((suffix) => addPointActivity(`${PREFIX}three_${suffix}`)));
    const result = await heatmap();
    expect(result.status).toBe(200);
    expect((result.body.cells as unknown[])).toHaveLength(1);
  });

  it('omits a cell with activity from one user', async () => {
    await addPointActivity(`${PREFIX}one`);
    const result = await heatmap();
    expect(result.body.cells).toEqual([]);
  });

  it('omits a cell with activity from two users at threshold three', async () => {
    await Promise.all(['a', 'b'].map((suffix) => addPointActivity(`${PREFIX}two_${suffix}`)));
    const result = await heatmap();
    expect(result.body.suppression_threshold_users).toBe(3);
    expect(result.body.cells).toEqual([]);
  });

  it('does not let one user reach the threshold by recording many activities in one cell', async () => {
    await Promise.all([1, 2, 3, 4, 5].map(() => addPointActivity(`${PREFIX}repeat`)));
    const result = await heatmap();
    expect(result.body.cells).toEqual([]);
  });

  it('excludes unverified activity', async () => {
    await Promise.all([
      addPointActivity(`${PREFIX}verified_a`),
      addPointActivity(`${PREFIX}verified_b`),
      addPointActivity(`${PREFIX}pending`, 'PENDING'),
    ]);
    const result = await heatmap();
    expect(result.body.cells).toEqual([]);
  });

  it('excludes activity belonging to a banned user', async () => {
    await Promise.all([
      addPointActivity(`${PREFIX}allowed_a`),
      addPointActivity(`${PREFIX}allowed_b`),
      addPointActivity(`${PREFIX}banned`),
    ]);
    await sql(`UPDATE users SET is_banned = true WHERE id = $1`, [`${PREFIX}banned`]);
    const result = await heatmap();
    expect(result.body.cells).toEqual([]);
  });

  it('serializes no user id, timestamp, or raw point fields', async () => {
    const users = [`${PREFIX}private_a`, `${PREFIX}private_b`, `${PREFIX}private_c`];
    await Promise.all(users.map((userId) => addPointActivity(userId)));
    const result = await heatmap();
    const body = JSON.stringify(result.body);
    for (const userId of users) expect(body).not.toContain(userId);
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(body).not.toMatch(/"(?:user_id|activity_id|recorded_at|seq|accuracy_m|speed_ms|altitude_m|geometry|raw_track|track)"/i);
    const cells = result.body.cells as { center: { lat: number; lng: number }; intensity: string }[];
    expect(Object.keys(cells[0]!).sort()).toEqual(['center', 'intensity']);
    expect(Object.keys(cells[0]!.center).sort()).toEqual(['lat', 'lng']);
  });

  it('rejects a window outside the fixed allowed values', async () => {
    const result = await heatmap('365d');
    expect(result.status).toBe(422);
  });

  it('accepts the allowed 30-day window', async () => {
    const result = await heatmap('30d');
    expect(result.status).toBe(200);
    expect(result.body.window).toBe('30d');
  });

  it('states the fixed grid, suppression threshold, and default time window', async () => {
    const result = await heatmap();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ window: '7d', grid_size_m: 100, suppression_threshold_users: 3 });
  });
});
