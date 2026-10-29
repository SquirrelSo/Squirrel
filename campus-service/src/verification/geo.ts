/**
 * Authoritative geospatial computations, all done by PostGIS.
 *
 * AREA zone   coverage = area( buffer(track ∩ zone, buffer_m) ∩ zone ) / area(zone)
 * ROUTE zone  route_completion = length( required_route ∩ buffer(track, tolerance_m) ) / length(required_route)
 * Both        distance_in_zone = length(track ∩ zone); time_in_zone = Σ dt of consecutive points inside the zone
 */
import type pg from 'pg';
import { many } from '../db/pool.js';
import { config } from '../config.js';

export type ZoneInteractionRaw = {
  zone_id: string; zone_type: 'AREA' | 'ROUTE'; threshold: number;
  min_time_s: number; min_distance_m: number;
  distance_in_zone_m: number; time_in_zone_s: number; coverage: number | null; route_completion: number | null;
};

/**
 * Compute interactions between a cleaned track (WKT LineString) and every active zone it intersects.
 * `activityId` is used to compute time-in-zone from the stored points.
 */
export async function computeZoneInteractions(activityId: string, trackWkt: string, q: pg.PoolClient | pg.Pool): Promise<ZoneInteractionRaw[]> {
  const r = config.rules;
  return many<ZoneInteractionRaw>(
    `WITH trk AS (SELECT ST_GeomFromText($2, 4326) AS g),
     hit AS (
       SELECT z.*, trk.g AS track FROM zones z, trk WHERE z.is_active AND ST_Intersects(z.geometry, trk.g)
     ),
     inside AS (
       -- every point of the activity, flagged per zone, with the time since the previous point
       SELECT h.id AS zone_id, p.seq, ST_Covers(h.geometry, p.geom) AS inz,
              EXTRACT(EPOCH FROM (p.recorded_at - lag(p.recorded_at) OVER (PARTITION BY h.id ORDER BY p.seq))) AS dt,
              lag(ST_Covers(h.geometry, p.geom)) OVER (PARTITION BY h.id ORDER BY p.seq) AS prev_inz
       FROM hit h JOIN activity_points p ON p.activity_id = $1
     ),
     tiz AS (
       -- time inside zone: sum of dt over segments whose both ends are inside (capped at 60 s per segment)
       SELECT zone_id, coalesce(sum(LEAST(dt, 60)), 0) AS t FROM inside WHERE inz AND prev_inz GROUP BY zone_id
     )
     SELECT h.id AS zone_id, h.zone_type,
       coalesce(h.qualify_threshold, CASE WHEN h.zone_type = 'ROUTE' THEN $3::float8 ELSE $4::float8 END) AS threshold,
       coalesce(h.min_time_in_zone_s, $5::int) AS min_time_s,
       coalesce(h.min_distance_in_zone_m, $6::float8) AS min_distance_m,
       ST_Length(ST_Intersection(h.track, h.geometry)::geography) AS distance_in_zone_m,
       coalesce((SELECT round(t) FROM tiz WHERE tiz.zone_id = h.id), 0)::int AS time_in_zone_s,
       CASE WHEN h.zone_type = 'AREA' THEN
         LEAST(1.0, ST_Area(ST_Intersection(
             ST_Buffer(ST_Intersection(h.track, h.geometry)::geography, coalesce(h.coverage_buffer_m, $7::float8))::geometry,
             h.geometry)::geography) / NULLIF(ST_Area(h.geometry::geography), 0))
       END AS coverage,
       CASE WHEN h.zone_type = 'ROUTE' AND h.required_route IS NOT NULL THEN
         LEAST(1.0, ST_Length(ST_Intersection(h.required_route, ST_Buffer(h.track::geography, coalesce(h.route_tolerance_m, $8::float8))::geometry)::geography)
               / NULLIF(ST_Length(h.required_route::geography), 0))
       END AS route_completion
     FROM hit h`,
    [activityId, trackWkt, r.routeZoneDefaultThreshold, r.areaZoneDefaultThreshold, r.minTimeInZoneS, r.minDistanceInZoneM, r.areaCoverageBufferM, r.routeMatchToleranceM], q,
  ).then((rows) => rows.map((x) => ({
    ...x, distance_in_zone_m: Number(x.distance_in_zone_m) || 0, time_in_zone_s: Number(x.time_in_zone_s) || 0,
    coverage: x.coverage === null ? null : Number(x.coverage), route_completion: x.route_completion === null ? null : Number(x.route_completion),
    threshold: Number(x.threshold), min_time_s: Number(x.min_time_s), min_distance_m: Number(x.min_distance_m),
  })));
}

/** Time-ordered points inside the zone → 'looped' if the track re-enters the zone near where it entered (AREA loops). */
export async function zonesIntersectingLine(trackWkt: string, q: pg.PoolClient | pg.Pool) {
  return many<{ zone_id: string }>(`SELECT id AS zone_id FROM zones WHERE is_active AND ST_Intersects(geometry, ST_GeomFromText($1, 4326))`, [trackWkt], q);
}
