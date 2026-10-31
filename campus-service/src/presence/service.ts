/**
 * Presence: where a user last was, for Active Now / Nearby. Exact fixes are stored (needed for
 * distance math and expiry) but NEVER returned. Consumers get proximity buckets or grid-snapped cells.
 */
import { config } from '../config.js';
import { getPool, many, one, query, type Queryable } from '../db/pool.js';
import { publish } from '../realtime/bus.js';

export type Proximity = 'very_close' | 'nearby' | 'on_campus';

export function bucket(distanceM: number | null): Proximity {
  if (distanceM === null) return 'on_campus';
  if (distanceM <= config.presence.veryCloseM) return 'very_close';
  if (distanceM <= config.presence.nearbyM) return 'nearby';
  return 'on_campus';
}

/** Snap to a grid cell centre so a position is never more precise than gridM. Pure. */
export function snapToGrid(lat: number, lng: number, gridM = config.presence.gridM): { lat: number; lng: number; precision_m: number } {
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  const cellLat = gridM / mPerDegLat, cellLng = gridM / mPerDegLng;
  return { lat: (Math.floor(lat / cellLat) + 0.5) * cellLat, lng: (Math.floor(lng / cellLng) + 0.5) * cellLng, precision_m: gridM };
}

export async function updatePresence(userId: string, lat: number, lng: number, accuracyM: number | null, q: Queryable = getPool()) {
  await query(
    `INSERT INTO presence (user_id, geom, accuracy_m, updated_at, expires_at)
     VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, now(), now() + ($5 || ' minutes')::interval)
     ON CONFLICT (user_id) DO UPDATE SET geom = EXCLUDED.geom, accuracy_m = EXCLUDED.accuracy_m, updated_at = now(), expires_at = EXCLUDED.expires_at`,
    [userId, lat, lng, accuracyM, String(config.presence.ttlMinutes)], q,
  );
}

export async function touchPresenceActivity(userId: string, activityId: string, type: 'run' | 'walk', startedAt: string) {
  await query(`UPDATE presence SET activity_id = $2, activity_type = $3, activity_started_at = $4 WHERE user_id = $1`, [userId, activityId, type, startedAt]);
  publish({ type: 'active.updated', data: { active_now: await activeNowCount() } });
}

export async function activeNowCount(q: Queryable = getPool()) {
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM presence WHERE expires_at > now()`, [], q);
  return r?.n ?? 0;
}

export type ActiveRow = {
  user_id: string; display_name: string; avatar_url: string | null; hostel: string | null; connection_mode: string | null; bio: string | null;
  open_to_meet: boolean; activity_type: string | null; activity_started_at: string | null; distance_m: number | null; updated_at: string;
  xp_total: number; xp_synced_at: string;
};

/**
 * People visible to `viewer` right now.
 *  - `active`: anyone on campus with a live activity (public), proximity only if BOTH are open to meet.
 *  - `nearby`: only when the viewer is open to meet; only others who are open to meet and within radius.
 */
export async function activePeople(viewerId: string, viewerOpen: boolean, q: Queryable = getPool()) {
  const rows = await many<ActiveRow>(
    `WITH me AS (SELECT geom FROM presence WHERE user_id = $1 AND expires_at > now())
     SELECT u.id AS user_id, u.display_name, u.avatar_url, h.short_name AS hostel, u.connection_mode, u.bio,
            -- consent as it stands now: Open to Meet on AND not lapsed (open_to_meet_until in the past = off)
            (u.open_to_meet AND (u.open_to_meet_until IS NULL OR u.open_to_meet_until > now())) AS open_to_meet,
            u.xp_total, u.xp_synced_at,
            p.activity_type, p.activity_started_at, p.updated_at,
            (SELECT ST_Distance(p.geom::geography, me.geom::geography) FROM me) AS distance_m
     FROM presence p JOIN users u ON u.id = p.user_id LEFT JOIN hostels h ON h.id = u.hostel_id
     WHERE p.expires_at > now() AND u.id <> $1 AND NOT u.is_banned
     ORDER BY p.updated_at DESC LIMIT 200`,
    [viewerId], q,
  );
  
  const { syncBatchXp } = await import('../run/index.js');
  await syncBatchXp(rows, q);
  
  const active = rows.filter((r) => r.activity_type).map((r) => ({ ...r, proximity: viewerOpen && r.open_to_meet ? bucket(r.distance_m) : null }));
  const nearby = viewerOpen
    ? rows.filter((r) => r.open_to_meet && r.distance_m !== null && r.distance_m <= config.presence.nearbyRadiusM).map((r) => ({ ...r, proximity: bucket(r.distance_m) }))
    : [];
  return { active, nearby, active_now: rows.length };
}

/**
 * Delete expired presence rows, so an exact fix is never kept past its 15-minute TTL.
 * Scheduled every minute by src/sweeper.ts (worker process, and the API when WORKER_INLINE).
 */
export async function sweepPresence(q: Queryable = getPool()): Promise<number> {
  const r = await query(`DELETE FROM presence WHERE expires_at <= now()`, [], q);
  return r.rowCount ?? 0;
}
