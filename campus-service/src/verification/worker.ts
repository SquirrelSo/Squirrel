/**
 * Verification worker: PENDING → PROCESSING → VERIFIED | PARTIALLY_VERIFIED | REJECTED,
 * then zone qualification results. Never touches territory ownership.
 */
import type pg from 'pg';
import { config } from '../config.js';
import { getPool, one, query, withTransaction } from '../db/pool.js';
import { addHours } from '../lib/time.js';
import { publish } from '../realtime/bus.js';
import { campusNotificationDedupeKey, notify } from '../notifications/service.js';
import { getActivity, loadPoints, publicVerification, type ActivityRow } from '../activities/repo.js';
import { toLineStringWkt } from '../activities/gps.js';
import { scoreActivity } from './anticheat.js';
import { computeZoneInteractions } from './geo.js';
import { evaluateQualification } from '../territory/rules.js';
import { claimJob, completeJob, failJob, type Job } from './queue.js';
import { getPersonLite } from '../users/repo.js';
import { getZone } from '../zones/repo.js';

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

export async function verifyActivity(activityId: string, log: Log = console): Promise<ActivityRow | null> {
  const pool = getPool();
  const a = await getActivity(activityId);
  if (!a) return null;
  if (!['PENDING', 'PROCESSING'].includes(a.verification_status)) return a; // already terminal (idempotent)
  await query(`UPDATE activities SET verification_status = 'PROCESSING', verification_attempts = verification_attempts + 1, updated_at = now() WHERE id = $1`, [activityId]);

  const points = await loadPoints(activityId);
  const result = scoreActivity({
    activityType: a.activity_type, points, clientDistanceM: a.client_distance_m, clientDurationS: a.client_duration_s,
    startedAt: a.started_at, endedAt: a.ended_at ?? points[points.length - 1]?.recorded_at ?? a.started_at, device: a.device_metadata,
  });
  const kept = result.keptPoints.map((i) => points[i]!);
  const trackWkt = kept.length >= 2 ? toLineStringWkt(kept) : null;
  const verified = result.band !== 'REJECTED';

  const zoneResults = await withTransaction(async (tx) => {
    await query(
      `UPDATE activities SET verification_status = $2, anti_cheat_score = $3, verification_reason = $4, verification_signals = $5,
         distance_m = $6, duration_s = $7, moving_time_s = $8, track = $9::geometry, verified_at = now(), updated_at = now() WHERE id = $1`,
      [activityId, result.band, result.score, result.reason, result.signals, result.stats.distanceM, Math.round(result.stats.elapsedS), Math.round(result.stats.movingTimeS), trackWkt ? `SRID=4326;${trackWkt}` : null], tx,
    );
    // Re-running verification replaces earlier results for this activity.
    await query(`DELETE FROM qualification_results WHERE activity_id = $1 AND status <> 'CLAIMED'`, [activityId], tx);
    if (!trackWkt) return [];
    const interactions = await computeZoneInteractions(activityId, trackWkt, tx);
    const out: { zone_id: string; qualified: boolean; owner_id: string | null }[] = [];
    const expiresAt = addHours(new Date(), config.rules.qualificationTtlHours);
    for (const z of interactions) {
      const ev = evaluateQualification({
        zoneType: z.zone_type, threshold: z.threshold, coverage: z.coverage, routeCompletion: z.route_completion,
        distanceInZoneM: z.distance_in_zone_m, timeInZoneS: z.time_in_zone_s, minTimeS: z.min_time_s, minDistanceM: z.min_distance_m, verified,
      });
      const status = ev.qualified ? 'QUALIFIED' : 'NOT_QUALIFIED';
      const t = await one<{ owner_id: string | null; shield_until: string | null }>(`SELECT owner_id, shield_until FROM territories WHERE zone_id = $1`, [z.zone_id], tx);
      // Owners re-qualifying on their own zone: still a QUALIFIED record (needed to defend).
      await query(
        `INSERT INTO qualification_results (activity_id, user_id, zone_id, status, verified, interaction, coverage, route_completion, distance_in_zone_m, time_in_zone_s, threshold, claim_available, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (activity_id, zone_id) DO NOTHING`,
        [activityId, a.user_id, z.zone_id, status, verified, ev.interaction, z.coverage, z.route_completion, z.distance_in_zone_m, z.time_in_zone_s, z.threshold, ev.qualified, ev.qualified ? expiresAt : null], tx,
      );
      out.push({ zone_id: z.zone_id, qualified: ev.qualified, owner_id: t?.owner_id ?? null });
    }
    return out;
  });

  const fresh = (await getActivity(activityId))!;
  const pub = publicVerification(fresh);
  publish({ type: 'activity.verified', user_ids: [a.user_id], data: { activity_id: activityId, status: fresh.verification_status, app_status: pub.app_status, zones: zoneResults.map((z) => ({ zone_id: z.zone_id, qualified: z.qualified })) } });
  const qualifiedZones = zoneResults.filter((z) => z.qualified);
  await notify(a.user_id, 'activity.verification_complete', verified ? 'Activity verified' : 'Activity could not be verified',
    verified ? `Your ${a.activity_type} was verified${qualifiedZones.length ? ` — you can claim ${qualifiedZones.length} zone${qualifiedZones.length > 1 ? 's' : ''}` : ''}.` : `Your ${a.activity_type} could not be verified.`,
    { activity_id: activityId, status: fresh.verification_status, route: '/notifications' }, null,
    campusNotificationDedupeKey('activity.verification_complete', activityId, a.user_id));

  // A rival now holds a live qualification on someone's territory → contested (once the shield lapses this is visible in reads).
  const actor = await getPersonLite(a.user_id);
  for (const z of qualifiedZones) {
    if (z.owner_id && z.owner_id !== a.user_id) {
      const t = await one<{ shield_until: string | null }>(`SELECT shield_until FROM territories WHERE zone_id = $1`, [z.zone_id]);
      const shielded = !!t?.shield_until && Date.parse(t.shield_until) > Date.now();
      const zone = await getZone(z.zone_id);
      if (!shielded) {
        publish({ type: 'territory.contested', zone_id: z.zone_id, data: { zone_id: z.zone_id, under_challenge: true } });
        const zoneName = zone?.name ?? 'your territory';
        await notify(z.owner_id, 'territory.challenged', 'Your territory is at risk', `{actor} qualified to challenge ${zoneName}. Defend it!`,
          { zone_id: z.zone_id, route: `/zone/${z.zone_id}` }, a.user_id,
          campusNotificationDedupeKey('territory.challenged', `${a.id}:${z.zone_id}`, z.owner_id));
      }
    }
  }
  log.info({ activityId, band: result.band, score: result.score, zones: zoneResults.length }, 'activity verified');
  return fresh;
}

async function runJob(job: Job, log: Log) {
  if (job.kind === 'verify_activity') {
    await verifyActivity(String(job.payload.activity_id), log);
  } else {
    log.warn({ job }, 'unknown job kind');
  }
}

/** Poll loop. Resolves when `signal` aborts. */
export async function startWorker(log: Log, signal?: AbortSignal) {
  const pool = getPool();
  let listener: pg.PoolClient | null = null;
  let wake: (() => void) | null = null;
  try {
    listener = await pool.connect();
    await listener.query('LISTEN campus_jobs');
    listener.on('notification', () => wake?.());
  } catch (e) { log.warn({ err: e }, 'job LISTEN unavailable; polling only'); }

  const sleep = (ms: number) => new Promise<void>((r) => { wake = r; const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  const loops = Array.from({ length: config.worker.concurrency }, async () => {
    while (!signal?.aborted) {
      let job: Job | null = null;
      try { job = await claimJob(); } catch (e) { log.error({ err: e }, 'claimJob failed'); await sleep(config.worker.pollMs * 5); continue; }
      if (!job) { await sleep(config.worker.pollMs); continue; }
      try { await runJob(job, log); await completeJob(job.id); }
      catch (e) {
        const dead = await failJob(job, e).catch(() => true);
        log.error({ err: e, jobId: job.id, dead }, 'job failed');
        if (dead && job.kind === 'verify_activity') {
          await query(`UPDATE activities SET verification_status = 'REJECTED', verification_reason = 'processing_failed', updated_at = now() WHERE id = $1 AND verification_status IN ('PENDING','PROCESSING')`, [job.payload.activity_id]).catch(() => undefined);
        }
      }
    }
  });
  await Promise.all(loops);
  listener?.release();
}
