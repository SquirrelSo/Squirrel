import { describe, it, expect } from 'vitest';
import { HAS_DB, resetDb } from './setup.js';
import { query } from '../../src/db/pool.js';
import { seedZones } from '../../src/seed/run.js';
import { ZONES, loadOsmZones } from '../../src/seed/zones.js';

const sql = async <T>(text: string, params: unknown[] = []) => (await query(text, params)).rows as T[];

// The default seed loads the committed OpenStreetMap import (zones.osm.json) over the placeholder.
describe.skipIf(!HAS_DB)('seeding the imported campus (integration)', () => {
  const imported = loadOsmZones();

  it('the test setup seeds the fixed placeholder map, whatever the import holds', async () => {
    await resetDb();
    const active = await sql<{ id: string; geometry_source: string }>(`SELECT id, geometry_source FROM zones WHERE is_active`);
    expect(active.length).toBe(ZONES.length);
    expect(new Set(active.map((z) => z.geometry_source))).toEqual(new Set(['dev_placeholder']));
  });

  it.skipIf(imported.length === 0)('the default seed puts the imported zones live and retires the placeholders', async () => {
    await resetDb();
    expect(await seedZones()).toBe('osm');
    const active = await sql<{ id: string; geometry_source: string; zone_type: string; has_route: boolean }>(
      `SELECT id, geometry_source, zone_type, required_route IS NOT NULL AS has_route FROM zones WHERE is_active ORDER BY id`);
    expect(active.map((z) => z.id)).toEqual(imported.map((z) => z.id).sort());
    for (const z of active) expect(['osm', 'traced']).toContain(z.geometry_source);
    for (const z of active.filter((x) => x.zone_type === 'ROUTE')) expect(z.has_route).toBe(true);
    const placeholders = await sql<{ n: string }>(`SELECT count(*) AS n FROM zones WHERE geometry_source = 'dev_placeholder' AND is_active`);
    expect(Number(placeholders[0]!.n)).toBe(0);
    // Running it again changes nothing (idempotent).
    await seedZones();
    const again = await sql<{ n: string }>(`SELECT count(*) AS n FROM zones WHERE is_active`);
    expect(Number(again[0]!.n)).toBe(imported.length);
  });
});
