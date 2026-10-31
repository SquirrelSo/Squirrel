/**
 * Leaderboards — computed from territory_events + activities + users, never hardcoded.
 *   GET /v1/leaderboards/squirrels?period=daily|weekly|alltime&limit=10&metric=xp|zones|distance
 *   GET /v1/leaderboards/hostels?period=
 * Results are cached in-process for 30 s (cheap; the underlying indexes keep the SQL fast anyway).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { periodStart } from '../lib/time.js';

const cache = new Map<string, { at: number; value: unknown }>();
const cached = async <T,>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> => {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
};

type SquirrelRow = { user_id: string; display_name: string; avatar_url: string | null; hostel: string | null; xp: number; zones_claimed: number; distance_m: number; rank: number };

async function squirrelBoard(period: 'daily' | 'weekly' | 'alltime', metric: 'xp' | 'zones' | 'distance', limit: number) {
  const since = periodStart(period).toISOString();
  const order = metric === 'xp' ? 'xp' : metric === 'zones' ? 'zones_claimed' : 'distance_m';
  return many<SquirrelRow>(
    `WITH ev AS (
       SELECT actor_id AS user_id, sum(xp_awarded)::int AS xp, count(*) FILTER (WHERE action IN ('CLAIM','STEAL'))::int AS zones_claimed
       FROM territory_events WHERE created_at >= $1 AND actor_id IS NOT NULL GROUP BY actor_id
     ), act AS (
       SELECT user_id, sum(distance_m)::float8 AS distance_m FROM activities
       WHERE verification_status IN ('VERIFIED','PARTIALLY_VERIFIED') AND started_at >= $1 GROUP BY user_id
     ), agg AS (
       SELECT u.id AS user_id, u.display_name, u.avatar_url, h.short_name AS hostel,
              CASE WHEN $3 = 'alltime' THEN u.xp_total ELSE coalesce(ev.xp, 0) END AS xp,
              coalesce(ev.zones_claimed, 0) AS zones_claimed, coalesce(act.distance_m, 0) AS distance_m
       FROM users u LEFT JOIN hostels h ON h.id = u.hostel_id LEFT JOIN ev ON ev.user_id = u.id LEFT JOIN act ON act.user_id = u.id
       WHERE NOT u.is_banned AND (ev.user_id IS NOT NULL OR act.user_id IS NOT NULL OR ($3 = 'alltime' AND u.xp_total > 0))
     )
     SELECT *, rank() OVER (ORDER BY ${order} DESC, xp DESC, user_id)::int AS rank FROM agg ORDER BY rank LIMIT $2`,
    [since, limit, period],
  );
}

export async function leaderboardRoutes(app: FastifyInstance) {
  app.get('/v1/leaderboards/squirrels', async (req) => {
    const q = z.object({ period: z.enum(['daily', 'weekly', 'alltime']).default('daily'), limit: z.coerce.number().int().min(1).max(100).default(10), metric: z.enum(['xp', 'zones', 'distance']).default('xp') }).parse(req.query);
    const entries = await cached(`sq:${q.period}:${q.metric}:${q.limit}`, 30_000, () => squirrelBoard(q.period, q.metric, q.limit));
    let me: SquirrelRow | null = null;
    if (req.user) {
      me = entries.find((e) => e.user_id === req.user!.id) ?? null;
      if (!me) {
        // Rank the viewer without loading the whole board
        const all = await cached(`sq:${q.period}:${q.metric}:all`, 30_000, () => squirrelBoard(q.period, q.metric, 10_000));
        me = all.find((e) => e.user_id === req.user!.id) ?? null;
      }
    }
    return { period: q.period, metric: q.metric, entries: entries.map((e) => ({ ...e, distance_m: Math.round(e.distance_m) })), me: me ? { ...me, distance_m: Math.round(me.distance_m) } : null, updated_at: new Date().toISOString() };
  });

  app.get('/v1/leaderboards/hostels', async (req) => {
    const q = z.object({ period: z.enum(['daily', 'weekly', 'alltime']).default('daily') }).parse(req.query);
    const since = periodStart(q.period).toISOString();
    const entries = await cached(`hb:${q.period}`, 30_000, () => many<{ hostel_id: string; name: string; territories: number; active_members: number; distance_m: number; xp: number; score: number; rank: number }>(
      `WITH held AS (
         SELECT u.hostel_id, count(*)::int AS territories FROM territories t JOIN users u ON u.id = t.owner_id WHERE u.hostel_id IS NOT NULL GROUP BY u.hostel_id
       ), act AS (
         SELECT u.hostel_id, count(DISTINCT a.user_id)::int AS active_members, sum(a.distance_m)::float8 AS distance_m
         FROM activities a JOIN users u ON u.id = a.user_id
         WHERE a.verification_status IN ('VERIFIED','PARTIALLY_VERIFIED') AND a.started_at >= $1 AND u.hostel_id IS NOT NULL GROUP BY u.hostel_id
       ), xp AS (
         SELECT u.hostel_id, sum(e.xp_awarded)::int AS xp FROM territory_events e JOIN users u ON u.id = e.actor_id WHERE e.created_at >= $1 AND u.hostel_id IS NOT NULL GROUP BY u.hostel_id
       ), agg AS (
         SELECT h.id AS hostel_id, h.short_name AS name, coalesce(held.territories, 0) AS territories, coalesce(act.active_members, 0) AS active_members,
                coalesce(act.distance_m, 0) AS distance_m, coalesce(xp.xp, 0) AS xp,
                (coalesce(held.territories, 0) * 100 + coalesce(xp.xp, 0) + round(coalesce(act.distance_m, 0) / 100) + coalesce(act.active_members, 0) * 5)::int AS score
         FROM hostels h LEFT JOIN held ON held.hostel_id = h.id LEFT JOIN act ON act.hostel_id = h.id LEFT JOIN xp ON xp.hostel_id = h.id
       )
       SELECT *, rank() OVER (ORDER BY score DESC, territories DESC, name)::int AS rank FROM agg ORDER BY rank`, [since]));
    return { period: q.period, entries: entries.map((e) => ({ ...e, distance_m: Math.round(e.distance_m) })), my_hostel_id: req.user?.hostel_id ?? null, updated_at: new Date().toISOString() };
  });

  void one;
}
