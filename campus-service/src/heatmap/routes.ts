import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/plugin.js';
import { many } from '../db/pool.js';

const HeatmapQuery = z.object({ window: z.enum(['7d', '30d']).default('7d') }).strict();
const WINDOW_DAYS = { '7d': 7, '30d': 30 } as const;
// 32645 is the campus's local UTM zone; the implicit (0,0) origin keeps this 100 m grid fixed.
const GRID_SIZE_M = 100;
export const SUPPRESSION_THRESHOLD_USERS = 3;
const MAX_CELLS = 500;

type HeatmapRow = { lat: number; lng: number; user_count: number };

export function intensityFor(users: number): 'low' | 'medium' | 'high' {
  // Coarse distinct-user bands only; the exact internal count never crosses the API boundary.
  if (users < 5) return 'low';
  if (users < 10) return 'medium';
  return 'high';
}

export async function heatmapRoutes(app: FastifyInstance) {
  app.get('/v1/map/heatmap', { preHandler: requireAuth }, async (req) => {
    const { window } = HeatmapQuery.parse(req.query ?? {});
    const rows = await many<HeatmapRow>(
      `WITH time_bounds AS (
         SELECT now() - make_interval(days => $1::int) AS window_start, now() AS window_end
       ), verified_points AS (
         SELECT
           ST_SnapToGrid(ST_Transform(p.geom, 32645), $2::double precision) AS cell_center,
           a.user_id
         FROM activities a
         JOIN users u ON u.id = a.user_id AND NOT u.is_banned
         JOIN activity_points p ON p.activity_id = a.id
         CROSS JOIN time_bounds b
         WHERE a.verification_status = 'VERIFIED'
           AND a.started_at >= b.window_start AND a.started_at < b.window_end
           AND p.recorded_at >= b.window_start AND p.recorded_at < b.window_end
       ), cell_users AS (
         SELECT cell_center, user_id
         FROM verified_points
         GROUP BY cell_center, user_id
       ), supported_cells AS (
         SELECT cell_center, count(*)::int AS user_count
         FROM cell_users
         GROUP BY cell_center
         HAVING count(*) >= $3::int
       ), limited_cells AS (
         SELECT cell_center, user_count
         FROM supported_cells
         ORDER BY user_count DESC, ST_Y(cell_center), ST_X(cell_center)
         LIMIT $4::int
       )
       SELECT ST_Y(ST_Transform(cell_center, 4326))::float8 AS lat,
              ST_X(ST_Transform(cell_center, 4326))::float8 AS lng,
              user_count
       FROM limited_cells`,
      [WINDOW_DAYS[window], GRID_SIZE_M, SUPPRESSION_THRESHOLD_USERS, MAX_CELLS],
    );

    return {
      window,
      grid_size_m: GRID_SIZE_M,
      suppression_threshold_users: SUPPRESSION_THRESHOLD_USERS,
      cells: rows.map((row) => ({
        center: { lat: Number(row.lat), lng: Number(row.lng) },
        intensity: intensityFor(Number(row.user_count)),
      })),
    };
  });
}
