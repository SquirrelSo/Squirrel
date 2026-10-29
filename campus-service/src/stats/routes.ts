/**
 * Campus / daily stats. GET /v1/campus/stats (app) and GET /v1/stats/daily (spec). Never hardcoded.
 */
import type { FastifyInstance } from 'fastify';
import { one } from '../db/pool.js';
import { socialCrewCount } from '../crews/count.js';

export async function campusStats() {
  const r = await one<{ users_total: number; users_active_now: number; zones_total: number; zones_claimed: number; zones_claimed_today: number; territory_changes_today: number; activities_today: number; active_squirrels_today: number; challenges_today: number; challenges_open: number; meetups_today: number }>(
    `SELECT
       (SELECT count(*) FROM users WHERE NOT is_banned)::int AS users_total,
       (SELECT count(*) FROM presence WHERE expires_at > now())::int AS users_active_now,
       (SELECT count(*) FROM zones WHERE is_active)::int AS zones_total,
       (SELECT count(*) FROM territories t JOIN zones z ON z.id = t.zone_id WHERE z.is_active AND t.owner_id IS NOT NULL)::int AS zones_claimed,
       (SELECT count(*) FROM territory_events WHERE action IN ('CLAIM','STEAL') AND created_at >= date_trunc('day', now()))::int AS zones_claimed_today,
       (SELECT count(*) FROM territory_events WHERE created_at >= date_trunc('day', now()))::int AS territory_changes_today,
       (SELECT count(*) FROM activities WHERE started_at >= date_trunc('day', now()) AND verification_status <> 'RECORDING')::int AS activities_today,
       (SELECT count(DISTINCT user_id) FROM activities WHERE started_at >= date_trunc('day', now()) AND verification_status IN ('VERIFIED','PARTIALLY_VERIFIED'))::int AS active_squirrels_today,
       (SELECT count(*) FROM challenges WHERE created_at >= date_trunc('day', now()))::int AS challenges_today,
       (SELECT count(*) FROM challenges WHERE status IN ('accepted','active'))::int AS challenges_open,
       (SELECT count(*) FROM meetups WHERE created_at >= date_trunc('day', now()))::int AS meetups_today`,
    [],
  );
  return { ...r!, crews_total: await socialCrewCount(), founding_spots_left: null, updated_at: new Date().toISOString() };
}

export async function statsRoutes(app: FastifyInstance) {
  app.get('/v1/campus/stats', async () => campusStats());
  app.get('/v1/stats/daily', async () => {
    const s = await campusStats();
    return { date: new Date().toISOString().slice(0, 10), active_squirrels: s.active_squirrels_today, zones_claimed_today: s.zones_claimed_today, crews: s.crews_total, activities: s.activities_today, territory_changes: s.territory_changes_today, meetups: s.meetups_today, challenges: s.challenges_today, users_active_now: s.users_active_now, updated_at: s.updated_at };
  });
}
