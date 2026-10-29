import { one, many, type Queryable, getPool } from '../db/pool.js';
import { config } from '../config.js';

export type LatLng = [number, number];

export type ZoneRow = {
  id: string; name: string; short_name: string | null; description: string | null;
  kind: 'hostel' | 'academic' | 'sports' | 'food' | 'library' | 'landmark';
  zone_type: 'AREA' | 'ROUTE';
  hostel_id: string | null; hostel_name: string | null;
  geometry_source: string; is_active: boolean; created_at: string; updated_at: string;
  qualify_threshold: number | null; coverage_buffer_m: number | null; route_tolerance_m: number | null;
  min_time_in_zone_s: number | null; min_distance_in_zone_m: number | null;
  geometry_geojson: string; centroid_geojson: string; required_route_geojson: string | null;
};

const ZONE_SELECT = `
  z.id, z.name, z.short_name, z.description, z.kind, z.zone_type, z.hostel_id, h.short_name AS hostel_name,
  z.geometry_source, z.is_active, z.created_at, z.updated_at,
  z.qualify_threshold, z.coverage_buffer_m, z.route_tolerance_m, z.min_time_in_zone_s, z.min_distance_in_zone_m,
  ST_AsGeoJSON(z.geometry) AS geometry_geojson, ST_AsGeoJSON(z.centroid) AS centroid_geojson,
  ST_AsGeoJSON(z.required_route) AS required_route_geojson
  FROM zones z LEFT JOIN hostels h ON h.id = z.hostel_id`;

export async function listZones(opts: { includeInactive?: boolean } = {}, q: Queryable = getPool()) {
  return many<ZoneRow>(`SELECT ${ZONE_SELECT} ${opts.includeInactive ? '' : 'WHERE z.is_active'} ORDER BY z.name`, [], q);
}

export async function getZone(zoneId: string, q: Queryable = getPool()) {
  return one<ZoneRow>(`SELECT ${ZONE_SELECT} WHERE z.id = $1`, [zoneId], q);
}

/** Zones whose polygon is within `radiusM` of a point (uses the GiST index). */
export async function zonesNear(lat: number, lng: number, radiusM: number, q: Queryable = getPool()) {
  return many<ZoneRow & { distance_m: number }>(
    `SELECT ${ZONE_SELECT}, ST_Distance(z.geometry::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_m
     WHERE z.is_active AND ST_DWithin(z.geometry::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
     ORDER BY distance_m`,
    [lat, lng, radiusM], q,
  );
}

// ---------------------------------------------------------------------------
// Serialisation (frontend-friendly): [lat, lng] rings for the app + GeoJSON for map libraries.
// ---------------------------------------------------------------------------

export function ringToLatLng(geojson: string): LatLng[] {
  const g = JSON.parse(geojson) as { type: string; coordinates: number[][][] };
  const ring = g.coordinates[0] ?? [];
  // Drop the closing duplicate point; the client closes rings itself.
  const pts = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.slice(0, -1) : ring;
  return pts.map(([lng, lat]) => [lat!, lng!] as LatLng);
}

export function pointToLatLng(geojson: string): LatLng {
  const g = JSON.parse(geojson) as { coordinates: [number, number] };
  return [g.coordinates[1], g.coordinates[0]];
}

export function lineToLatLng(geojson: string | null): LatLng[] | null {
  if (!geojson) return null;
  const g = JSON.parse(geojson) as { coordinates: number[][] };
  return g.coordinates.map(([lng, lat]) => [lat!, lng!] as LatLng);
}

export type ZoneOut = {
  id: string; name: string; short_name: string | null; description: string | null; kind: ZoneRow['kind'];
  zone_type: 'AREA' | 'ROUTE'; polygon: LatLng[]; centroid: LatLng; geometry: unknown;
  required_route: LatLng[] | null; hostel: string | null; hostel_id: string | null;
  qualification: { threshold: number; metric: 'coverage' | 'route_completion' };
  geometry_source: string; is_active: boolean; updated_at: string;
};

export function zoneThreshold(z: Pick<ZoneRow, 'zone_type' | 'qualify_threshold'>): number {
  return z.qualify_threshold ?? (z.zone_type === 'ROUTE' ? config.rules.routeZoneDefaultThreshold : config.rules.areaZoneDefaultThreshold);
}

export function serializeZone(z: ZoneRow): ZoneOut {
  return {
    id: z.id, name: z.name, short_name: z.short_name, description: z.description, kind: z.kind, zone_type: z.zone_type,
    polygon: ringToLatLng(z.geometry_geojson), centroid: pointToLatLng(z.centroid_geojson), geometry: JSON.parse(z.geometry_geojson),
    required_route: lineToLatLng(z.required_route_geojson),
    hostel: z.hostel_name, hostel_id: z.hostel_id,
    qualification: { threshold: zoneThreshold(z), metric: z.zone_type === 'ROUTE' ? 'route_completion' : 'coverage' },
    geometry_source: z.geometry_source, is_active: z.is_active, updated_at: z.updated_at,
  };
}
