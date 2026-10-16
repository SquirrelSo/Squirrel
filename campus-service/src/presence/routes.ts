import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { errors } from '../lib/errors.js';
import { haversineM } from '../activities/gps.js';
import { config } from '../config.js';
import { activePeople, activeNowCount, snapToGrid, updatePresence, type ActiveRow } from './service.js';
import { getPool, many } from '../db/pool.js';
import { isBlockedEitherWay, getFullBlockSet } from '../blocks/service.js';

const PresenceBody = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy_m: z.number().min(0).max(5000).nullable().optional() });

function personCard(r: ActiveRow & { proximity: string | null }) {
  // Activity-first card; no location, no route. Only what the person already shows on their public profile.
  return {
    person: { user_id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url, hostel: r.hostel, connection_mode: r.connection_mode, bio: r.bio, level: Math.floor(r.xp_total / 2000) + 1, xp: r.xp_total },
    activity: r.activity_type ? { type: r.activity_type, started_at: r.activity_started_at } : null,
    proximity: r.proximity,
  };
}

export async function presenceRoutes(app: FastifyInstance) {
  // PUT /v1/map/presence — report my own location (throttled by the app; rate-limited here too)
  app.put('/v1/map/presence', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = currentUser(req);
    const b = PresenceBody.parse(req.body ?? {});
    if (haversineM(config.campus.centerLat, config.campus.centerLng, b.lat, b.lng) > config.campus.maxRadiusM) return { accepted: false, reason: 'off_campus' };
    await updatePresence(user.id, b.lat, b.lng, b.accuracy_m ?? null);
    return { accepted: true };
  });

  const activeHandler = async (req: FastifyRequest) => {
    const user = currentUser(req);
    const viewerOpen = user.open_to_meet && (!user.open_to_meet_until || Date.parse(user.open_to_meet_until) > Date.now());
    try {
      const r = await activePeople(user.id, viewerOpen);
      const active = [];
      const nearby = [];
      const blocks = await getFullBlockSet(user.id);
      for (const p of r.active) if (!blocks.has(p.user_id)) active.push(personCard(p));
      for (const p of r.nearby) if (!blocks.has(p.user_id)) nearby.push(personCard(p));
      return { active_now: r.active_now, active, nearby, as_of: new Date().toISOString(), visible: viewerOpen, hidden_reason: viewerOpen ? null : 'open_to_meet_off' };
    } catch (err: any) {
      if (err.code === 'blocks_unreachable') return { active_now: 0, active: [], nearby: [], as_of: new Date().toISOString(), visible: viewerOpen, hidden_reason: 'blocks_unreachable' };
      throw err;
    }
  };
  // App route + spec aliases
  app.get('/v1/people/active', { preHandler: requireAuth }, activeHandler);
  app.get('/v1/activity/active', { preHandler: requireAuth }, activeHandler);
  app.get('/v1/activity/nearby', { preHandler: requireAuth }, async (req) => {
    const r = await activeHandler(req);
    return { nearby: r.nearby, as_of: r.as_of, visible: r.visible, hidden_reason: r.hidden_reason, radius_m: config.presence.nearbyRadiusM };
  });

  // GET /v1/map/players — grid-snapped positions of people who are open to meet (never raw fixes)
  app.get('/v1/map/players', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const viewerOpen = user.open_to_meet && (!user.open_to_meet_until || Date.parse(user.open_to_meet_until) > Date.now());
    if (!viewerOpen) return { players: [], as_of: new Date().toISOString(), visible: false, hidden_reason: 'open_to_meet_off' };
    const rows = await many<ActiveRow & { lat: number; lng: number }>(
      `WITH me AS (SELECT geom FROM presence WHERE user_id = $1 AND expires_at > now())
       SELECT u.id AS user_id, u.display_name, u.avatar_url, h.short_name AS hostel, u.connection_mode, u.bio, u.open_to_meet, u.xp_total, u.xp_synced_at,
              p.activity_type, p.activity_started_at, p.updated_at, ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng,
              (SELECT ST_Distance(p.geom::geography, me.geom::geography) FROM me) AS distance_m
       FROM presence p JOIN users u ON u.id = p.user_id LEFT JOIN hostels h ON h.id = u.hostel_id
       WHERE p.expires_at > now() AND u.id <> $1 AND u.open_to_meet AND (u.open_to_meet_until IS NULL OR u.open_to_meet_until > now())
         AND NOT u.is_banned LIMIT 200`, [user.id], getPool(),
    );
    const { syncBatchXp } = await import('../run/index.js');
    await syncBatchXp(rows, getPool());
    
    const players = [];
    try {
      const blocks = await getFullBlockSet(user.id);
      for (const r of rows) {
        if (!blocks.has(r.user_id)) {
          const s = snapToGrid(r.lat, r.lng);
          players.push({ user_id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url, hostel: r.hostel, level: Math.floor(r.xp_total / 2000) + 1, xp: r.xp_total,
            position: [s.lat, s.lng], precision_m: s.precision_m, proximity: r.distance_m === null ? 'on_campus' : r.distance_m <= config.presence.veryCloseM ? 'very_close' : r.distance_m <= config.presence.nearbyM ? 'nearby' : 'on_campus',
            activity: r.activity_type, last_seen_at: r.updated_at, relationship: 'none' });
        }
      }
    } catch (err: any) {
      if (err.code === 'blocks_unreachable') return { players: [], as_of: new Date().toISOString(), visible: true, hidden_reason: 'blocks_unreachable' };
      throw err;
    }
    return { players, as_of: new Date().toISOString(), visible: true, hidden_reason: null };
  });

  app.get('/v1/activity/active-count', async () => ({ active_now: await activeNowCount(), as_of: new Date().toISOString() }));

  void errors;
}
