import { describe, expect, it } from 'vitest';
import { api, HAS_DB, sql, submitAndVerify, useTestApp } from './setup.js';
import { sweepRect, trackAlong } from '../helpers.js';

const sweep = () => trackAlong([[-100, -100], [75, 45], ...sweepRect(70, 40, 195, 150, 20), [300, 300], [-100, -100]], 3.2);

async function active(userId: string) {
  await submitAndVerify(userId, sweep());
  await api('PUT', '/v1/me/open-to-meet', userId, { enabled: true });
}

function peopleOf(response: Record<string, unknown>) {
  return (response.zones as { zone: { id: string }; people: { user_id: string; activity: string }[] }[])
    .find((entry) => entry.zone.id === 'cc1')?.people ?? [];
}

describe.skipIf(!HAS_DB)('shared zones and map features (integration)', () => {
  useTestApp();

  it('two users active in the same zone see each other', async () => {
    await active('cs2_shared_me');
    await active('cs2_shared_other');
    const result = await api('GET', '/v1/me/shared-zones', 'cs2_shared_me');
    expect(result.status).toBe(200);
    expect(peopleOf(result.body).map((person) => person.user_id)).toContain('cs2_shared_other');
  });

  it('a user with only an unverified activity does not appear', async () => {
    await active('cs2_unverified_me');
    await active('cs2_unverified_other');
    await sql(`UPDATE activities SET verification_status = 'PENDING' WHERE user_id = $1`, ['cs2_unverified_other']);
    const result = await api('GET', '/v1/me/shared-zones', 'cs2_unverified_me');
    expect(peopleOf(result.body).map((person) => person.user_id)).not.toContain('cs2_unverified_other');
  });

  it('a blocked user is excluded in either blocking direction', async () => {
    await active('cs2_block_me');
    await active('cs2_blocked_by_me');
    await active('cs2_blocking_me');
    await api('POST', '/v1/users/cs2_blocked_by_me/block', 'cs2_block_me');
    await api('POST', '/v1/users/cs2_block_me/block', 'cs2_blocking_me');
    const result = await api('GET', '/v1/me/shared-zones', 'cs2_block_me');
    expect(peopleOf(result.body).map((person) => person.user_id)).not.toEqual(expect.arrayContaining(['cs2_blocked_by_me', 'cs2_blocking_me']));
  });

  it('a user with open_to_meet false does not appear', async () => {
    await active('cs2_consent_me');
    await active('cs2_consent_other');
    await api('PUT', '/v1/me/open-to-meet', 'cs2_consent_other', { enabled: false });
    const result = await api('GET', '/v1/me/shared-zones', 'cs2_consent_me');
    expect(peopleOf(result.body).map((person) => person.user_id)).not.toContain('cs2_consent_other');
  });

  it('shared-zone responses contain no activity timestamps or coordinates', async () => {
    await active('cs2_private_me');
    await active('cs2_private_other');
    const result = await api('GET', '/v1/me/shared-zones', 'cs2_private_me');
    const json = JSON.stringify(result.body);
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(json).not.toMatch(/"(?:lat|lng|latitude|longitude|geometry|coordinates|polygon|centroid|recorded_at|started_at|created_at|updated_at)"/i);
  });

  it('the shared-zone cap is enforced', async () => {
    const activityId = await submitAndVerify('cs2_cap_me', sweep());
    const inserted = await sql(
      `INSERT INTO qualification_results (activity_id, user_id, zone_id, status, verified, interaction)
       SELECT $1, $2, z.id, 'NOT_QUALIFIED', true, 'visited' FROM zones z WHERE z.is_active
       ON CONFLICT (activity_id, zone_id) DO NOTHING RETURNING zone_id`,
      [activityId, 'cs2_cap_me'],
    );
    expect(inserted.length).toBeGreaterThan(0);
    const result = await api('GET', '/v1/me/shared-zones', 'cs2_cap_me');
    expect((result.body.zones as unknown[]).length).toBe(10);
    expect(result.body.cap).toEqual({ zones: 10, people_per_zone: 5 });
  });

  it('map features returns active zones with matching geometry and geometry_source', async () => {
    const features = await api('GET', '/v1/map/features', null);
    const zones = await api('GET', '/v1/zones?format=geojson', null);
    expect(features.status).toBe(200);
    const feature = (features.body.features as { id: string; geometry: unknown; properties: Record<string, unknown> }[]).find((item) => item.id === 'cc1');
    const zoneFeature = (zones.body.features as { id: string; geometry: unknown; properties: Record<string, unknown> }[]).find((item) => item.id === 'cc1');
    expect(feature?.geometry).toEqual(zoneFeature?.geometry);
    expect(feature?.properties.geometry_source).toBe('dev_placeholder');
  });

  it('an inactive zone does not appear in map features', async () => {
    await sql(`UPDATE zones SET is_active = false WHERE id = 'cc1'`);
    const result = await api('GET', '/v1/map/features', null);
    expect((result.body.features as { id: string }[]).map((feature) => feature.id)).not.toContain('cc1');
  });

  it('map features contain no user or presence data', async () => {
    const result = await api('GET', '/v1/map/features', null);
    const json = JSON.stringify(result.body);
    expect(json).not.toMatch(/"(?:user_id|owner_id|owner|person|presence|latitude|longitude|lat|lng|position|last_seen)"/i);
  });

  it('map feature ownership agrees with the public territories endpoint', async () => {
    await api('GET', '/v1/me', 'cs2_map_owner');
    await sql(`UPDATE zones SET is_active = true WHERE id = 'cc1'`);
    await sql(`UPDATE territories SET owner_type = 'USER', owner_id = 'cs2_map_owner', status = 'CLAIMED' WHERE zone_id = 'cc1'`);
    const [features, territories] = await Promise.all([
      api('GET', '/v1/map/features', null),
      api('GET', '/v1/territories', null),
    ]);
    const feature = (features.body.features as { id: string; properties: { territory: { state: string; owner_type: string } } }[]).find((item) => item.id === 'cc1');
    const territory = (territories.body.territories as { zone_id: string; state: string; owner_type: string; status: string }[]).find((item) => item.zone_id === 'cc1');
    expect(feature?.properties.territory.state).toBe(territory?.state);
    expect(feature?.properties.territory.owner_type).toBe(territory?.owner_type);
    expect(feature?.properties.territory.under_challenge).toBe(territory?.status === 'under_attack');
    expect(['CLAIMED', 'CONTESTED']).toContain(feature?.properties.territory.state);
    expect(feature?.properties.territory.owner_type).toBe('USER');
  });
});
