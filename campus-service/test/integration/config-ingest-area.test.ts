import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { api, HAS_DB, useTestApp } from './setup.js';

/**
 * /v1/config announces the GPS ingest area (centre + max_radius_m) that POST /v1/activities enforces,
 * so clients can drop off-campus fixes instead of losing the whole run to one of them.
 */
describe.skipIf(!HAS_DB)('config: GPS ingest area (integration)', () => {
  useTestApp();

  it('announces the same centre and radius the ingest check uses', async () => {
    const { status, body } = await api('GET', '/v1/config', null);
    expect(status).toBe(200);
    const campus = body.campus as { center: [number, number]; max_radius_m: number };
    expect(campus.center).toEqual([config.campus.centerLat, config.campus.centerLng]);
    expect(campus.max_radius_m).toBe(config.campus.maxRadiusM);
  });

  it('a point just beyond max_radius_m fails the upload with invalid_gps', async () => {
    const campus = (await api('GET', '/v1/config', null)).body.campus as { center: [number, number]; max_radius_m: number };
    const [lat, lng] = campus.center;
    const dLat = (campus.max_radius_m + 200) / 111_320; // ~200 m outside, due north
    // A gradual walk out of the area (2.5 m/s, one fix a second, all in the past), so only the area
    // rule — not a jump, not a future timestamp — can trip.
    const steps = Math.ceil((campus.max_radius_m + 200) / 2.5);
    const t0 = Date.now() - (steps + 60) * 1000;
    const points = Array.from({ length: steps + 1 }, (_, i) => ({ lat: lat + (dLat * i) / steps, lng, recorded_at: new Date(t0 + i * 1000).toISOString(), accuracy_m: 8 }));
    const res = await api('POST', '/v1/activities', 'u_area', { type: 'run', started_at: points[0]!.recorded_at, ended_at: points.at(-1)!.recorded_at, points });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_gps');
    expect(String(res.body.detail)).toMatch(/outside the campus area/);
  });
});
