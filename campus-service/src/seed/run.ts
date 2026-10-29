/**
 * npm run seed — idempotent development seed: hostels, ~16 IISER Kolkata zones (placeholder geometry),
 * territory rows, and (outside production) a handful of dev users.
 *
 * Zones only (hostels + zones + territory rows; never users or crews):
 *   npm run seed:zones · node dist/seed/run.js --zones-only · SEED_ZONES_ON_START=1 node dist/index.js
 * Geometry is only ever overwritten while a zone's geometry_source is still 'dev_placeholder'.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { closePool, query } from '../db/pool.js';
import { HOSTELS, ROUTE_ZONE_PAD_M, ZONES, loadOsmZones, osmLineWkt, osmPolygonWkt, polygonWkt, lineWkt } from './zones.js';

/**
 * The OpenStreetMap campus (zones.osm.json), when imported: its halls and zones are written with
 * geometry_source 'osm' (or 'traced' for a recorded loop), replacing placeholder, earlier OSM or traced
 * geometry (never surveyed geometry), and
 * placeholder or earlier-imported zones it doesn't include are switched off. ROUTE zones keep their
 * loop, threshold and type; their outline is the feature plus ROUTE_ZONE_PAD_M around the loop.
 * Returns false when there's nothing imported.
 */
async function seedOsmZones(): Promise<boolean> {
  const zones = loadOsmZones();
  if (!zones.length) return false;
  for (const z of zones.filter((z) => z.kind === 'hostel')) {
    await query(`INSERT INTO hostels (id, name, short_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name`, [z.id, z.name, z.short_name ?? z.name]);
  }
  for (const z of zones) {
    const route = z.zone_type === 'ROUTE' && z.route && z.route.length >= 2 ? osmLineWkt(z.route) : null;
    await query(
      `WITH r AS (SELECT CASE WHEN $8::text IS NULL THEN NULL ELSE ST_GeomFromText($8, 4326) END AS line),
       u AS (
         -- AREA: the feature. ROUTE: the feature plus the filled loop, padded so the path is inside.
         SELECT CASE WHEN r.line IS NULL THEN ST_GeomFromText($6, 4326)
                ELSE ST_Union(ST_GeomFromText($6, 4326),
                       ST_Buffer((CASE WHEN ST_IsClosed(r.line) THEN ST_MakePolygon(r.line) ELSE r.line END)::geography, $10)::geometry) END AS geom
         FROM r
       ),
       g AS (SELECT d.geom FROM u, ST_Dump(ST_MakeValid(u.geom)) d WHERE GeometryType(d.geom) = 'POLYGON' ORDER BY ST_Area(d.geom) DESC LIMIT 1)
       INSERT INTO zones (id, name, short_name, description, kind, zone_type, geometry, centroid, required_route, qualify_threshold, hostel_id, geometry_source)
       SELECT $1, $2, $3, $4, $5, $9, g.geom, ST_Centroid(g.geom), CASE WHEN $8::text IS NULL THEN NULL ELSE ST_GeomFromText($8, 4326) END, $11, $7, $12 FROM g
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, kind = EXCLUDED.kind, hostel_id = EXCLUDED.hostel_id, is_active = true,
         geometry = CASE WHEN zones.geometry_source IN ('dev_placeholder', 'osm', 'traced') THEN EXCLUDED.geometry ELSE zones.geometry END,
         centroid = CASE WHEN zones.geometry_source IN ('dev_placeholder', 'osm', 'traced') THEN EXCLUDED.centroid ELSE zones.centroid END,
         zone_type = CASE WHEN zones.geometry_source IN ('dev_placeholder', 'osm', 'traced') THEN EXCLUDED.zone_type ELSE zones.zone_type END,
         required_route = CASE WHEN zones.geometry_source IN ('dev_placeholder', 'osm', 'traced') THEN EXCLUDED.required_route ELSE zones.required_route END,
         qualify_threshold = CASE WHEN zones.geometry_source IN ('dev_placeholder', 'osm', 'traced') THEN EXCLUDED.qualify_threshold ELSE zones.qualify_threshold END,
         geometry_source = CASE WHEN zones.geometry_source IN ('dev_placeholder', 'osm', 'traced') THEN EXCLUDED.geometry_source ELSE zones.geometry_source END,
         updated_at = now()`,
      [z.id, z.name, z.short_name, z.source === 'traced' ? `${z.name} (traced lap).` : `${z.name} (OpenStreetMap).`, z.kind, osmPolygonWkt(z.polygon), z.kind === 'hostel' ? z.id : null,
        route, route ? 'ROUTE' : 'AREA', ROUTE_ZONE_PAD_M, route ? z.threshold ?? null : null, z.source === 'traced' ? 'traced' : 'osm'],
    );
    await query(`INSERT INTO territories (zone_id) VALUES ($1) ON CONFLICT DO NOTHING`, [z.id]);
  }
  // Placeholder zones OSM doesn't have, and zones an earlier import had but this one doesn't (a
  // renamed or removed feature), are switched off. Their history stays; surveyed zones are untouched.
  await query(`UPDATE zones SET is_active = false, updated_at = now() WHERE geometry_source IN ('dev_placeholder', 'osm', 'traced') AND is_active AND NOT (id = ANY($1::text[]))`, [zones.map((z) => z.id)]);
  return true;
}

/**
 * Hostels and zones. By default the imported campus (zones.osm.json) when there is one, else the
 * placeholder layout. `source: 'placeholder'` always seeds the placeholder: the integration tests
 * use it so they run against a fixed, known map, not whatever the last OpenStreetMap import held.
 * Returns where the zones came from, for the log line.
 */
export async function seedZones(opts: { source?: 'auto' | 'placeholder' } = {}): Promise<'osm' | 'dev_placeholder'> {
  if (opts.source !== 'placeholder' && (await seedOsmZones())) return 'osm';
  for (const h of HOSTELS) await query(`INSERT INTO hostels (id, name, short_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name`, [h.id, h.name, h.short]);
  for (const z of ZONES) {
    await query(
      `INSERT INTO zones (id, name, short_name, description, kind, zone_type, geometry, centroid, required_route, qualify_threshold, hostel_id, geometry_source)
       VALUES ($1, $2, $3, $4, $5, $6, ST_GeomFromText($7, 4326), ST_Centroid(ST_GeomFromText($7, 4326)), $8, $9, $10, 'dev_placeholder')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, description = EXCLUDED.description, kind = EXCLUDED.kind, zone_type = EXCLUDED.zone_type,
         geometry = CASE WHEN zones.geometry_source = 'dev_placeholder' THEN EXCLUDED.geometry ELSE zones.geometry END,
         centroid = CASE WHEN zones.geometry_source = 'dev_placeholder' THEN EXCLUDED.centroid ELSE zones.centroid END,
         required_route = CASE WHEN zones.geometry_source = 'dev_placeholder' THEN EXCLUDED.required_route ELSE zones.required_route END,
         qualify_threshold = EXCLUDED.qualify_threshold, hostel_id = EXCLUDED.hostel_id, updated_at = now()`,
      [z.id, z.name, z.short, z.description, z.kind, z.zoneType, polygonWkt(z.xy), z.routeXy ? `SRID=4326;${lineWkt(z.routeXy)}` : null, z.threshold ?? null, z.hostel],
    );
    await query(`INSERT INTO territories (zone_id) VALUES ($1) ON CONFLICT DO NOTHING`, [z.id]);
  }
  return 'dev_placeholder';
}

export const DEV_USERS = [
  { id: 'u_aanya', name: 'Aanya Moves', email: 'aanya@iiserkol.ac.in', hostel: 'nivedita' },
  { id: 'u_rhea', name: 'Rhea Runs', email: 'rhea@iiserkol.ac.in', hostel: 'nscb' },
  { id: 'u_kabir', name: 'Kabir Cycles', email: 'kabir@iiserkol.ac.in', hostel: 'vidyasagar' },
  { id: 'u_dev', name: 'Dev Squirrel', email: 'dev@iiserkol.ac.in', hostel: 'nivedita' },
];

export async function seedDevUsers() {
  for (const u of DEV_USERS) {
    await query(
      `INSERT INTO users (id, display_name, email, email_domain, hostel_id, onboarding_completed, founding_member)
       VALUES ($1, $2, $3, $4, (SELECT id FROM hostels WHERE id = $5), true, true) ON CONFLICT (id) DO UPDATE SET hostel_id = EXCLUDED.hostel_id`,
      [u.id, u.name, u.email, u.email.split('@')[1], u.hostel]);
  }
}

export async function seed(opts: { zonesOnly?: boolean } = {}) {
  const source = await seedZones();
  const withUsers = !opts.zonesOnly && !config.isProd;
  if (withUsers) await seedDevUsers();
  const zones = source === 'osm' ? `${loadOsmZones().length} OpenStreetMap zones` : `${HOSTELS.length} hostels, ${ZONES.length} placeholder zones`;
  console.log(`seeded ${zones}${withUsers ? `, ${DEV_USERS.length} dev users` : ''} (geometry_source = ${source})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed({ zonesOnly: process.argv.includes('--zones-only') }).then(() => closePool()).catch((e) => { console.error(e); process.exit(1); });
}
