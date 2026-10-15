/**
 * Me / users / open-to-meet / notifications / config.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getPool, many, one, withTransaction } from '../db/pool.js';
import { errors } from '../lib/errors.js';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { getUser, updateUser, type UserRow } from './repo.js';
import { getPeopleLite } from './repo.js';
import { authConfigured } from '../auth/jwt.js';
import { isBlockedEitherWay } from '../blocks/service.js';
import { lookupCrewMemberships, lookupCrews } from '../identity/index.js';
import { leaveBubble } from '../bubble/service.js';


const MePatch = z.object({
  display_name: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(280).nullable().optional(),
  avatar_url: z.string().url().max(500).nullable().optional(),
  connection_mode: z.enum(['date', 'friends', 'crew']).nullable().optional(),
  hostel_zone_id: z.string().max(64).nullable().optional(),
  hostel_id: z.string().max(64).nullable().optional(),
  onboarding_completed: z.boolean().optional(),
  date_mode_enabled: z.boolean().optional(),
}).strict();

const OpenToMeet = z.object({ enabled: z.boolean(), hours: z.number().min(1).max(24 * 7).optional() });

async function profileStats(userId: string) {
  const s = await one<{ total_distance_m: number; month_distance_m: number; zones_claimed: number; territories_defended: number; territories_stolen: number }>(
    `SELECT
       coalesce((SELECT sum(distance_m) FROM activities WHERE user_id = $1 AND verification_status IN ('VERIFIED','PARTIALLY_VERIFIED')), 0)::float8 AS total_distance_m,
       coalesce((SELECT sum(distance_m) FROM activities WHERE user_id = $1 AND verification_status IN ('VERIFIED','PARTIALLY_VERIFIED') AND started_at > date_trunc('month', now())), 0)::float8 AS month_distance_m,
       (SELECT count(*) FROM territory_events WHERE actor_id = $1 AND action IN ('CLAIM','STEAL'))::int AS zones_claimed,
       (SELECT count(*) FROM territory_events WHERE actor_id = $1 AND action = 'DEFEND')::int AS territories_defended,
       (SELECT count(*) FROM territory_events WHERE actor_id = $1 AND action = 'STEAL')::int AS territories_stolen`,
    [userId],
  );
  const memberships = (await lookupCrewMemberships([userId])).get(userId) || [];
  return { total_distance_m: Math.round(s?.total_distance_m ?? 0), month_distance_m: Math.round(s?.month_distance_m ?? 0), zones_claimed: s?.zones_claimed ?? 0, territories_defended: s?.territories_defended ?? 0, territories_stolen: s?.territories_stolen ?? 0, crew_memberships: memberships.length, events_attended: 0, streak_days: null };
}

export async function publicProfile(u: UserRow, viewerId: string | null) {
  const hostel = u.hostel_id ? await one<{ short_name: string }>(`SELECT short_name FROM hostels WHERE id = $1`, [u.hostel_id]) : null;
  const territories = await many<{ zone_id: string; zone_name: string; claimed_at: string; defended_count: number }>(
    `SELECT t.zone_id, z.name AS zone_name, t.claimed_at, t.defense_count AS defended_count FROM territories t JOIN zones z ON z.id = t.zone_id WHERE t.owner_id = $1 ORDER BY t.claimed_at DESC`, [u.id]);
  const crewsData = (await lookupCrewMemberships([u.id])).get(u.id) || [];
  const crews = crewsData.map(c => ({ id: c.id, name: c.name, color: null, icon: null, role: c.role }));
  const recent = viewerId === u.id ? await many<{ id: string; activity_type: string; started_at: string; distance_m: number | null; duration_s: number | null; verification_status: string; zones_count: number }>(
    `SELECT a.id, a.activity_type, a.started_at, a.distance_m, a.duration_s, a.verification_status,
            (SELECT count(*) FROM qualification_results q WHERE q.activity_id = a.id AND q.interaction <> 'passed_through')::int AS zones_count
     FROM activities a WHERE a.user_id = $1 AND a.verification_status <> 'RECORDING' ORDER BY a.started_at DESC LIMIT 10`, [u.id]) : [];
  return {
    user_id: u.id, display_name: u.display_name, avatar_url: u.avatar_url, hostel: hostel?.short_name ?? null,
    bio: u.bio, connection_mode: u.connection_mode, open_to_meet: u.open_to_meet,
    verification: { email_verified: !!u.email_domain, email_domain: u.email_domain, student_verified: !!u.email_domain && config.campus.emailDomains.includes(u.email_domain), phone_verified: false, selfie_verified: false },
    stats: await profileStats(u.id), territories, crews, badges: [],
    recent_activities: recent.map((a) => ({ id: a.id, type: a.activity_type, started_at: a.started_at, distance_m: Math.round(a.distance_m ?? 0), duration_s: a.duration_s ?? 0, zones_count: a.zones_count,
      status: a.verification_status === 'VERIFIED' ? 'verified' : a.verification_status === 'PARTIALLY_VERIFIED' ? 'flagged' : a.verification_status === 'REJECTED' ? 'rejected' : 'processing' })),
    joined_at: u.created_at, founding_member: u.founding_member, level: Math.floor(u.xp_total / 2000) + 1, campus_xp: u.xp_total,
  };
}

async function meResponse(req: FastifyRequest) {
  const u = (await getUser(currentUser(req).id))!;
  return { ...(await publicProfile(u, u.id)), email: u.email, hostel_zone_id: u.hostel_id, hostel_id: u.hostel_id, date_mode_enabled: u.date_mode_enabled, onboarding_completed: u.onboarding_completed, safety_contact_configured: false,
    open_to_meet_until: u.open_to_meet_until };
}

export async function userRoutes(app: FastifyInstance) {
  app.get('/v1/config', async () => ({
    campus: { id: config.campus.id, name: config.campus.name, short_name: config.campus.shortName, email_domains: config.campus.emailDomains, center: [config.campus.centerLat, config.campus.centerLng], max_radius_m: config.campus.maxRadiusM, launched_at: null },
    features: { create_crew: true, create_event: false, defend: true, open_to_meet: true, date_mode: { available: false, reason: 'Date Mode opens once the safety features are live on campus.', requirements: [] }, meetup_safety_notifications: true },
    realtime_url: config.realtime.publicUrl,
    rules: { qualification_ttl_hours: config.rules.qualificationTtlHours, claim_shield_hours: config.rules.claimShieldHours, action_cooldown_seconds: config.rules.userActionCooldownSeconds },
    auth_configured: authConfigured(),
  }));

  app.get('/v1/me', { preHandler: requireAuth }, meResponse);
  app.patch('/v1/me', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    // Reject profile_details before schema parsing so strict() doesn't swallow the key silently.
    // Private profile details moved to Exercise: PUT /api/me/profile-details.
    if (req.body && typeof req.body === 'object' && 'profile_details' in (req.body as object)) {
      throw errors.invalid('profile_details is no longer stored here. Use PUT /api/me/profile-details on the Exercise service.');
    }
    const p = MePatch.parse(req.body ?? {});
    const patch: Record<string, unknown> = {};
    if (p.display_name !== undefined) patch.display_name = p.display_name;
    if (p.bio !== undefined) patch.bio = p.bio;
    if (p.avatar_url !== undefined) patch.avatar_url = p.avatar_url;
    if (p.connection_mode !== undefined) patch.connection_mode = p.connection_mode;
    if (p.onboarding_completed !== undefined) patch.onboarding_completed = p.onboarding_completed;
    if (p.date_mode_enabled !== undefined) patch.date_mode_enabled = p.date_mode_enabled;
    const hostelRef = p.hostel_id !== undefined ? p.hostel_id : p.hostel_zone_id;
    if (hostelRef !== undefined) {
      if (hostelRef === null) patch.hostel_id = null;
      else {
        // Accept a hostel id or a hostel zone id.
        const h = await one<{ id: string }>(`SELECT h.id FROM hostels h WHERE h.id = $1 UNION SELECT z.hostel_id FROM zones z WHERE z.id = $1 AND z.hostel_id IS NOT NULL LIMIT 1`, [hostelRef]);
        if (!h) throw errors.invalid('Unknown hostel');
        patch.hostel_id = h.id;
      }
    }
    await withTransaction(async (tx) => {
      await updateUser(user.id, patch, tx);
    });
    return meResponse(req);
  });

  const openToMeetHandler = async (req: FastifyRequest) => {
    const user = currentUser(req);
    const b = OpenToMeet.parse(req.body ?? {});
    if (b.enabled) {
      const activity = await one<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM activities WHERE user_id = $1 AND verification_status = 'VERIFIED') AS exists`,
        [user.id],
      );
      if (!activity?.exists) {
        throw errors.conflict('verified_activity_required', 'Record and verify a run or walk first to turn on Open to Meet.');
      }
    }
    const until = b.enabled ? new Date(Date.now() + (b.hours ?? 12) * 3_600_000).toISOString() : null;
    const u = (await updateUser(user.id, { open_to_meet: b.enabled, open_to_meet_updated_at: new Date().toISOString(), open_to_meet_until: until }))!;
    // Open to Meet is the bubble's opt-in: switching it off leaves the bubble at once.
    if (!b.enabled) await leaveBubble(user.id).catch((err) => req.log.warn({ err }, 'leave bubble failed'));
    return { enabled: u.open_to_meet, updated_at: u.open_to_meet_updated_at, visible_until: u.open_to_meet_until };
  };
  app.put('/v1/me/open-to-meet', { preHandler: requireAuth }, openToMeetHandler);     // app
  app.patch('/v1/me/open-to-meet', { preHandler: requireAuth }, openToMeetHandler);   // spec
  app.patch('/v1/users/me/open-to-meet', { preHandler: requireAuth }, openToMeetHandler);

  app.get('/v1/users/:id', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(req.params);
    const u = await getUser(id);
    if (!u || u.is_banned) throw errors.notFound('Squirrel');
    const profile = await publicProfile(u, req.user?.id ?? null);
    return profile;
  });

  app.get('/v1/users/:id/context', { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(req.params);
    try {
      if (await isBlockedEitherWay(me.id, id)) throw errors.notFound('Squirrel');
    } catch (err: any) {
      if (err.statusCode === 404) throw err;
      if (err.code === 'blocks_unreachable') return { shared_zones: [], shared_crews: [], shared_events: [], icebreakers: [], hidden_reason: 'blocks_unreachable' };
      throw err;
    }
    if (!(await getUser(id))) throw errors.notFound('Squirrel');
    const shared = await many<{ zone_id: string; zone_name: string; relation: string }>(
      `WITH mine AS (SELECT DISTINCT zone_id FROM qualification_results WHERE user_id = $1 AND interaction <> 'passed_through' AND evaluated_at > now() - interval '30 days'),
            theirs AS (SELECT DISTINCT zone_id FROM qualification_results WHERE user_id = $2 AND interaction <> 'passed_through' AND evaluated_at > now() - interval '30 days')
       SELECT z.id AS zone_id, z.name AS zone_name,
         CASE WHEN t.owner_id = $1 THEN 'you_own_they_ran' WHEN t.owner_id = $2 THEN 'they_own_you_ran' ELSE 'both_ran' END AS relation
       FROM mine JOIN theirs USING (zone_id) JOIN zones z ON z.id = mine.zone_id LEFT JOIN territories t ON t.zone_id = z.id LIMIT 10`, [me.id, id]);
    const mems = await lookupCrewMemberships([me.id, id]);
    const myCrews = mems.get(me.id) || [];
    const theirCrews = new Set((mems.get(id) || []).map(c => c.id));
    const crews = myCrews.filter(c => theirCrews.has(c.id)).map(c => ({ id: c.id, name: c.name, color: null as string | null, icon: null as string | null }));
    const icebreakers = [
      ...shared.slice(0, 3).map((s) => ({ id: `zone-${s.zone_id}`, kind: 'shared_zone', text: `You both run ${s.zone_name}.`, zone_id: s.zone_id, action: { type: 'challenge', zone_id: s.zone_id } })),
      ...crews.slice(0, 2).map((c) => ({ id: `crew-${c.id}`, kind: 'shared_crew', text: `You're both in ${c.name}.`, crew_id: c.id })),
    ];
    return { shared_zones: shared, shared_crews: crews, shared_events: [], icebreakers };
  });

  app.get('/v1/me/badges', { preHandler: requireAuth }, async () => ({ badges: [] }));
}
