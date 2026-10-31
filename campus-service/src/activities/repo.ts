import { one, many, query, type Queryable, getPool } from '../db/pool.js';

export type ActivityRow = {
  id: string; user_id: string; activity_type: 'run' | 'walk';
  verification_status: 'RECORDING' | 'PENDING' | 'PROCESSING' | 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'REJECTED';
  started_at: string; ended_at: string | null; client_distance_m: number | null; client_duration_s: number | null;
  distance_m: number | null; duration_s: number | null; moving_time_s: number | null; point_count: number;
  anti_cheat_score: number | null; verification_reason: string | null; verification_signals: Record<string, unknown> | null;
  verification_attempts: number; device_metadata: Record<string, unknown> | null;
  finished_at: string | null; verified_at: string | null; created_at: string; updated_at: string;
};

export const getActivity = (id: string, q: Queryable = getPool()) => one<ActivityRow>('SELECT * FROM activities WHERE id = $1', [id], q);

export async function listActivities(userId: string, limit: number, cursor: string | null, q: Queryable = getPool()) {
  const rows = await many<ActivityRow>(
    `SELECT * FROM activities WHERE user_id = $1 ${cursor ? 'AND started_at < $3' : ''} ORDER BY started_at DESC LIMIT $2`,
    cursor ? [userId, limit + 1, cursor] : [userId, limit + 1], q,
  );
  const page = rows.slice(0, limit);
  return { items: page, next_cursor: rows.length > limit ? page[page.length - 1]!.started_at : null };
}

export async function lastPoint(activityId: string, q: Queryable = getPool()) {
  return one<{ seq: number; lat: number; lng: number; recorded_at: string; accuracy_m: number }>(
    `SELECT seq, ST_Y(geom) AS lat, ST_X(geom) AS lng, recorded_at, accuracy_m FROM activity_points WHERE activity_id = $1 ORDER BY seq DESC LIMIT 1`, [activityId], q,
  );
}

export async function loadPoints(activityId: string, q: Queryable = getPool()) {
  return many<{ seq: number; lat: number; lng: number; recorded_at: string; accuracy_m: number; speed_ms: number | null }>(
    `SELECT seq, ST_Y(geom) AS lat, ST_X(geom) AS lng, recorded_at, accuracy_m, speed_ms FROM activity_points WHERE activity_id = $1 ORDER BY seq`, [activityId], q,
  );
}

/** Bulk insert points (multi-row VALUES). Duplicate seqs are ignored so replays are harmless. */
export async function insertPoints(activityId: string, points: { seq: number; lat: number; lng: number; recorded_at: string; accuracy_m: number; speed_ms?: number | null; altitude_m?: number | null }[], q: Queryable) {
  if (!points.length) return 0;
  const cols = 7;
  const values = points.map((_, i) => `($1, $${i * cols + 2}, ST_SetSRID(ST_MakePoint($${i * cols + 3}, $${i * cols + 4}), 4326), $${i * cols + 5}, $${i * cols + 6}, $${i * cols + 7}, $${i * cols + 8})`).join(',');
  const params: unknown[] = [activityId];
  for (const p of points) params.push(p.seq, p.lng, p.lat, p.recorded_at, p.accuracy_m, p.speed_ms ?? null, p.altitude_m ?? null);
  const r = await query(`INSERT INTO activity_points (activity_id, seq, geom, recorded_at, accuracy_m, speed_ms, altitude_m) VALUES ${values} ON CONFLICT DO NOTHING`, params, q);
  return r.rowCount ?? 0;
}

/** Public shape. Internal anti-cheat detail is deliberately reduced to a coarse band + user-safe reason. */
export function serializeActivity(a: ActivityRow) {
  return {
    id: a.id, user_id: a.user_id, type: a.activity_type, status: a.verification_status,
    started_at: a.started_at, ended_at: a.ended_at,
    distance_m: a.distance_m === null ? null : Math.round(a.distance_m), duration_s: a.duration_s, moving_time_s: a.moving_time_s, point_count: a.point_count,
    verification: publicVerification(a),
    created_at: a.created_at, updated_at: a.updated_at,
  };
}

export function publicVerification(a: ActivityRow) {
  const band = a.anti_cheat_score === null ? null : a.anti_cheat_score >= 0.75 ? 'accept' : a.anti_cheat_score >= 0.45 ? 'review' : 'reject';
  return {
    status: a.verification_status,
    band, // coarse verdict only; the raw score and signal breakdown stay server-side
    reason: userFacingReason(a.verification_reason),
    verified_at: a.verified_at,
    // App-compatible status for ActivityHistoryItem / ActivityZones
    app_status: a.verification_status === 'VERIFIED' ? 'verified' : a.verification_status === 'PARTIALLY_VERIFIED' ? 'flagged' : a.verification_status === 'REJECTED' ? 'rejected' : 'processing',
  } as const;
}

const REASONS: Record<string, string> = {
  too_short: 'Too short to count — activities need at least 200 m and 60 s.',
  too_fast: 'Faster than any runner — this looks like a vehicle.',
  gps_jumps: 'Too many GPS jumps to trust the route.',
  poor_accuracy: 'GPS accuracy was too poor for most of the activity.',
  timestamp_gaps: 'Large gaps in the recording.',
  no_points: 'No GPS points were uploaded.',
  too_long: 'Longer than the maximum activity duration.',
  segments_dropped: 'Some GPS segments were excluded; the rest was credited.',
  ok: 'Looks good. Every metre counted.',
};
export const userFacingReason = (r: string | null) => (r ? REASONS[r.split(':')[0]!] ?? 'Verification could not confirm this activity.' : null);
