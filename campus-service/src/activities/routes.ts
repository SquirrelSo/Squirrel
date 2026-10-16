/**
 * Activities (runs / walks).
 *
 *   POST /v1/activities                      create (optionally with the full point array → finishes immediately)
 *   POST /v1/activities/:id/points           { idempotency_key, points[] }  ≤ 1000 per batch, seq = index in full array
 *   POST /v1/activities/:id/finish           { ended_at?, client_distance_m?, client_duration_s?, device? } → PENDING, queued
 *   GET  /v1/activities                      my history (cursor paging)
 *   GET  /v1/activities/:id                  summary (server-derived stats)
 *   GET  /v1/activities/:id/verification     status + coarse band + user-safe reason (no raw signals)
 *   GET  /v1/activities/:id/zones            zones the activity interacted with + current territory + my actions
 *   GET  /v1/runs/:id/zones                  alias used by the mobile app
 *
 * Ownership rule: a user sees only their own activities. Zone interactions come from the
 * verification pipeline — never from anything the client claims.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getPool, one, many, query, withTransaction } from '../db/pool.js';
import { errors } from '../lib/errors.js';
import { isUuid } from '../lib/ids.js';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { PointSchema, validatePoints, toLineStringWkt, type Point } from './gps.js';
import { getActivity, insertPoints, lastPoint, listActivities, serializeActivity, publicVerification, type ActivityRow } from './repo.js';
import { enqueueVerification } from '../verification/queue.js';
import { getZone, serializeZone } from '../zones/repo.js';
import { getTerritory, territoryOut } from '../territory/repo.js';
import { actionsFor } from '../territory/service.js';
import { touchPresenceActivity } from '../presence/service.js';
import { onPresenceActivityChanged } from '../bubble/service.js';

const CreateBody = z.object({
  type: z.enum(['run', 'walk']).default('run'),
  activity_type: z.enum(['run', 'walk']).optional(),
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }).optional(),
  points: z.array(PointSchema).max(config.gps.maxPointsPerActivity).optional(),
  client_distance_m: z.number().min(0).max(200_000).optional(),
  client_duration_s: z.number().int().min(0).max(86_400).optional(),
  device: z.record(z.unknown()).optional(),
});
const PointsBody = z.object({ idempotency_key: z.string().min(1).max(200).optional(), points: z.array(PointSchema).min(1).max(config.gps.maxPointsPerBatch) });
const FinishBody = z.object({
  ended_at: z.string().datetime({ offset: true }).optional(),
  client_distance_m: z.number().min(0).max(200_000).optional(),
  client_duration_s: z.number().int().min(0).max(86_400).optional(),
  device: z.record(z.unknown()).optional(),
});
const IdParam = z.object({ id: z.string().refine(isUuid, 'invalid id') });

function assignSeq(points: Point[], startSeq: number) {
  return points.map((p, i) => ({ ...p, seq: p.seq ?? startSeq + i }));
}

export async function activityRoutes(app: FastifyInstance) {
  const ownActivity = async (id: string, userId: string): Promise<ActivityRow> => {
    const a = await getActivity(id);
    if (!a || a.user_id !== userId) throw errors.notFound('Activity');
    return a;
  };

  app.post('/v1/activities', { preHandler: requireAuth, config: { rateLimit: { max: 50, timeWindow: '1 day' } } }, async (req, reply) => {
    const user = currentUser(req);
    const body = CreateBody.parse(req.body ?? {});
    const type = body.activity_type ?? body.type;
    const startedAt = new Date(body.started_at);
    if (startedAt.getTime() > Date.now() + 60_000) throw errors.invalid('started_at is in the future');
    if (Date.now() - startedAt.getTime() > 7 * 86_400_000) throw errors.invalid('started_at is too far in the past');

    const points = body.points ? assignSeq(body.points, 0) : null;
    if (points) validatePoints(points, null, { startedAt: body.started_at, maxPoints: config.gps.maxPointsPerActivity });

    const activity = await withTransaction(async (tx) => {
      const a = (await one<ActivityRow>(
        `INSERT INTO activities (user_id, activity_type, started_at, ended_at, client_distance_m, client_duration_s, device_metadata, verification_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [user.id, type, body.started_at, points ? body.ended_at ?? points[points.length - 1]!.recorded_at : null, body.client_distance_m ?? null, body.client_duration_s ?? null, body.device ?? null, points ? 'PENDING' : 'RECORDING'],
        tx,
      ))!;
      if (points) {
        const n = await insertPoints(a.id, points, tx);
        await query(`UPDATE activities SET point_count = $2, raw_track = $3::geometry, finished_at = now() WHERE id = $1`, [a.id, n, points.length >= 2 ? `SRID=4326;${toLineStringWkt(points)}` : null], tx);
        await enqueueVerification(a.id, tx);
      }
      return (await getActivity(a.id, tx))!;
    });
    if (!points) {
      await touchPresenceActivity(user.id, activity.id, type, activity.started_at).catch(() => undefined);
      await onPresenceActivityChanged(user.id, true);
    }
    reply.code(201);
    return { activity_id: activity.id, run_id: activity.id, ...serializeActivity(activity) };
  });

  app.post('/v1/activities/:id/points', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const user = currentUser(req);
    const { id } = IdParam.parse(req.params);
    const body = PointsBody.parse(req.body ?? {});
    const a = await ownActivity(id, user.id);
    if (a.verification_status !== 'RECORDING') throw errors.conflict('activity_finished', 'This activity is no longer recording.');
    if (a.point_count + body.points.length > config.gps.maxPointsPerActivity) throw errors.payloadTooLarge(`An activity may hold at most ${config.gps.maxPointsPerActivity} points`);

    const key = body.idempotency_key ?? null;
    if (key) {
      const seen = await one(`SELECT 1 FROM activity_point_batches WHERE activity_id = $1 AND idempotency_key = $2`, [id, key]);
      if (seen) return { accepted: 0, replayed: true, point_count: a.point_count };
    }
    const prev = await lastPoint(id);
    const points = assignSeq(body.points, prev ? prev.seq + 1 : 0);
    // Sort defensively by seq so an out-of-order batch still validates in order.
    points.sort((x, y) => x.seq - y.seq);
    if (prev && points[0]!.seq <= prev.seq) {
      // Retry of an already-stored range without a key → treat as replay if all seqs already exist.
      const existing = await one<{ n: number }>(`SELECT count(*)::int AS n FROM activity_points WHERE activity_id = $1 AND seq BETWEEN $2 AND $3`, [id, points[0]!.seq, points[points.length - 1]!.seq]);
      if ((existing?.n ?? 0) === points.length) return { accepted: 0, replayed: true, point_count: a.point_count };
      throw errors.invalidGps(`seq must continue after ${prev.seq}`);
    }
    validatePoints(points, prev ? { ...prev, seq: prev.seq } : null, { startedAt: a.started_at });

    const accepted = await withTransaction(async (tx) => {
      const n = await insertPoints(id, points, tx);
      await query(`UPDATE activities SET point_count = point_count + $2, updated_at = now() WHERE id = $1`, [id, n], tx);
      if (key) await query(`INSERT INTO activity_point_batches (activity_id, idempotency_key, seq_from, seq_to) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [id, key, points[0]!.seq, points[points.length - 1]!.seq], tx);
      return n;
    });
    return { accepted, replayed: false, point_count: a.point_count + accepted };
  });

  app.post('/v1/activities/:id/finish', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const user = currentUser(req);
    const { id } = IdParam.parse(req.params);
    const body = FinishBody.parse(req.body ?? {});
    const a = await ownActivity(id, user.id);
    if (a.verification_status !== 'RECORDING') return { activity_id: id, status: a.verification_status, replayed: true };

    const pts = await many<{ lat: number; lng: number; recorded_at: string }>(`SELECT ST_Y(geom) AS lat, ST_X(geom) AS lng, recorded_at FROM activity_points WHERE activity_id = $1 ORDER BY seq`, [id]);
    const endedAt = body.ended_at ?? pts[pts.length - 1]?.recorded_at ?? new Date().toISOString();
    if (Date.parse(endedAt) < Date.parse(a.started_at)) throw errors.invalid('ended_at is before started_at');
    if (Date.parse(endedAt) - Date.parse(a.started_at) > config.gps.maxActivityHours * 3_600_000) throw errors.invalid(`Activities longer than ${config.gps.maxActivityHours} h are not accepted`);

    await withTransaction(async (tx) => {
      await query(
        `UPDATE activities SET verification_status = 'PENDING', ended_at = $2, finished_at = now(), raw_track = $3::geometry,
           client_distance_m = COALESCE($4, client_distance_m), client_duration_s = COALESCE($5, client_duration_s),
           device_metadata = COALESCE($6, device_metadata), updated_at = now() WHERE id = $1`,
        [id, endedAt, pts.length >= 2 ? `SRID=4326;${toLineStringWkt(pts)}` : null, body.client_distance_m ?? null, body.client_duration_s ?? null, body.device ?? null], tx,
      );
      await enqueueVerification(id, tx);
    });
    const ended = await query(`UPDATE presence SET activity_id = NULL, activity_type = NULL, activity_started_at = NULL WHERE user_id = $1 AND activity_id = $2`, [user.id, id]).catch(() => null);
    if (ended?.rowCount) await onPresenceActivityChanged(user.id, false);
    return { activity_id: id, status: 'PENDING' as const, replayed: false };
  });

  app.get('/v1/activities', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().datetime({ offset: true }).optional() }).parse(req.query);
    const page = await listActivities(user.id, q.limit, q.cursor ?? null);
    const zonesCount = await many<{ activity_id: string; n: number }>(
      `SELECT activity_id, count(*)::int AS n FROM qualification_results WHERE activity_id = ANY($1::uuid[]) AND interaction <> 'passed_through' GROUP BY activity_id`,
      [page.items.map((a) => a.id)],
    );
    const zc = new Map(zonesCount.map((r) => [r.activity_id, r.n]));
    return {
      items: page.items.map((a) => ({ ...serializeActivity(a), zones_count: zc.get(a.id) ?? 0 })),
      next_cursor: page.next_cursor,
    };
  });

  app.get('/v1/activities/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const a = await ownActivity(id, currentUser(req).id);
    const track = await one<{ g: string | null }>(`SELECT ST_AsGeoJSON(track) AS g FROM activities WHERE id = $1`, [id]);
    return { ...serializeActivity(a), track: track?.g ? JSON.parse(track.g) : null };
  });

  app.get('/v1/activities/:id/verification', { preHandler: requireAuth }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const a = await ownActivity(id, currentUser(req).id);
    return { activity_id: id, ...publicVerification(a), attempts: a.verification_attempts };
  });

  const zonesHandler = async (req: FastifyRequest) => {
    const user = currentUser(req);
    const { id } = IdParam.parse(req.params);
    const a = await ownActivity(id, user.id);
    const v = publicVerification(a);
    const quals = await many<{ zone_id: string; interaction: 'passed_through' | 'looped' | 'visited'; status: string; coverage: number | null; route_completion: number | null; distance_in_zone_m: number; time_in_zone_s: number; threshold: number | null; expires_at: string | null; claim_available: boolean }>(
      `SELECT zone_id, interaction, status, coverage, route_completion, distance_in_zone_m, time_in_zone_s, threshold, expires_at, claim_available FROM qualification_results WHERE activity_id = $1 ORDER BY distance_in_zone_m DESC`, [id],
    );
    const zones = [];
    for (const qr of quals) {
      const zone = await getZone(qr.zone_id);
      const territory = await getTerritory(qr.zone_id);
      if (!zone || !territory) continue;
      zones.push({
        zone_id: zone.id, zone_name: zone.name, interaction: qr.interaction,
        distance_in_zone_m: Math.round(qr.distance_in_zone_m), time_in_zone_s: qr.time_in_zone_s,
        qualification: { status: qr.status, metric: zone.zone_type === 'ROUTE' ? 'route_completion' : 'coverage', value: zone.zone_type === 'ROUTE' ? qr.route_completion : qr.coverage, threshold: qr.threshold, expires_at: qr.expires_at },
        zone: serializeZone(zone),
        territory: await territoryOut(territory),
        actions: await actionsFor(user, zone, territory, getPool()), // live: ownership may have changed since the run
      });
    }
    return { activity_id: id, run_id: id, status: v.app_status, verification: v, zones };
  };
  app.get('/v1/activities/:id/zones', { preHandler: requireAuth }, zonesHandler);
  app.get('/v1/runs/:id/zones', { preHandler: requireAuth }, zonesHandler);
}
