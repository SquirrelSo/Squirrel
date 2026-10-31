/**
 * Challenges ("challenge invites" in the app).
 *
 *   GET  /v1/challenge-invites/types
 *   GET  /v1/challenge-invites?box=incoming|outgoing|all
 *   POST /v1/challenge-invites            { type, target: {type:'user'|'crew', id}, zone_id, starts_at, message?, ends_at? }
 *   POST /v1/challenge-invites/:id/accept | decline | cancel | start | complete
 *   PATCH /v1/challenge-invites/:id/schedule { starts_at, ends_at? }
 *   (aliases: /v1/challenges…)
 *
 * State machine: pending → accepted → active → completed; pending → declined | cancelled | expired; accepted → cancelled.
 * Who may do what is decided here, never by the client.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one, query, withTransaction } from '../db/pool.js';
import { lookupCrewMemberships, lookupCrewMembershipsWithStatus, lookupCrews, lookupCrewsWithStatus, type SocialCrewRef, type SocialCrew } from '../identity/index.js';
import { crewDisplays, crewOrPlaceholder } from '../crews/display.js';
import { errors } from '../lib/errors.js';
import { isUuid } from '../lib/ids.js';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { publish } from '../realtime/bus.js';
import { campusNotificationDedupeKey, notify } from '../notifications/service.js';
import { getPeopleLite } from '../users/repo.js';
import { isBlockedEitherWay } from '../blocks/service.js';

export const CHALLENGE_TYPES = [
  { id: 'territory', label: 'Territory duel', description: 'Whoever holds the zone when time runs out wins.', requires_zone: true, targets: ['user', 'crew'] },
  { id: 'weekend_war', label: 'Weekend War', description: 'Hostel vs hostel: most zones held over the weekend.', requires_zone: false, targets: ['crew'] },
  { id: 'zone_race', label: 'Zone race', description: 'First to qualify in the zone after the start wins.', requires_zone: true, targets: ['user'] },
  { id: 'group_activity', label: 'Group activity', description: 'Run or walk together; everyone who finishes gets XP.', requires_zone: false, targets: ['user', 'crew'] },
] as const;

export type ChallengeRow = {
  id: string; type: string; created_by: string; target_type: 'user' | 'crew'; target_user_id: string | null; target_crew_id: string | null; zone_id: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'active' | 'completed';
  starts_at: string; ends_at: string | null; message: string | null; responded_by: string | null; responded_at: string | null; started_at: string | null; completed_at: string | null;
  winner_user_id: string | null; winner_crew_id: string | null; result_summary: string | null; result: unknown; created_at: string; updated_at: string;
  zone_name: string | null;
};

export const CHALLENGE_SELECT = `SELECT ch.*, z.name AS zone_name
  FROM challenges ch LEFT JOIN zones z ON z.id = ch.zone_id`;
const SELECT = CHALLENGE_SELECT;

export type ChallengeAction = 'accept' | 'decline' | 'cancel' | 'schedule' | 'start' | 'complete';
type ActionFacts = { isCreator: boolean; isTarget: boolean; isParticipant: boolean };

/** Single source of truth for the action list and the action routes. */
function allowedActions(r: ChallengeRow, facts: ActionFacts, now: number): ChallengeAction[] {
  const actions: ChallengeAction[] = [];
  if (facts.isTarget && r.status === 'pending') actions.push('accept', 'decline');
  if (facts.isCreator && ['pending', 'accepted'].includes(r.status)) actions.push('cancel');
  if (facts.isCreator && ['pending', 'accepted'].includes(r.status)) actions.push('schedule');
  if (facts.isParticipant && r.status === 'accepted' && Date.parse(r.starts_at) <= now + 15 * 60_000) actions.push('start');
  if (facts.isParticipant && r.status === 'active' && (!r.ends_at || Date.parse(r.ends_at) <= now)) actions.push('complete');
  return actions;
}

function respondsFor(r: ChallengeRow, viewerId: string, memberships: Map<string, SocialCrewRef[]>): boolean {
  if (r.target_type === 'user') return r.target_user_id === viewerId;
  const targetCrew = (memberships.get(viewerId) ?? []).find((c) => c.id === r.target_crew_id);
  return !!targetCrew && (targetCrew.role === 'owner' || targetCrew.role === 'admin');
}

function participantFor(r: ChallengeRow, viewerId: string, crews: Map<string, SocialCrew>): boolean {
  if (r.created_by === viewerId || r.target_user_id === viewerId) return true;
  return !!r.target_crew_id && !!crews.get(r.target_crew_id)?.members.some((m) => m.subject === viewerId);
}

function challengeNotificationRoute(zoneId: string | null, crewId: string | null): string {
  if (zoneId) return `/zone/${zoneId}`;
  if (crewId) return `/crew/${crewId}`;
  // Temporary until group activity challenges have their own screen; Invites contains Social duels only.
  return '/notifications';
}

const CreateBody = z.object({
  type: z.enum(['territory', 'weekend_war', 'zone_race', 'group_activity']),
  target: z.object({ type: z.enum(['user', 'crew']), id: z.string().min(1).max(128) }),
  zone_id: z.string().max(64).nullable().optional(),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  message: z.string().trim().max(280).optional(),
});

export async function serializeChallenges(rows: ChallengeRow[], viewerId: string) {
  const people = await getPeopleLite(rows.flatMap((r) => [r.created_by, r.target_user_id, r.winner_user_id]).filter((x): x is string => !!x), getPool());
  const crewIds = rows.map((r) => r.target_crew_id).filter((x): x is string => !!x);
  const [membershipResult, crewResult] = await Promise.all([
    lookupCrewMembershipsWithStatus([viewerId]),
    lookupCrewsWithStatus(crewIds),
  ]);
  const crews = await crewDisplays(rows.map((r) => r.target_crew_id));
  return rows.map((r) => {
    const typeInfo = CHALLENGE_TYPES.find((t) => t.id === r.type);
    const crew = crewOrPlaceholder(r.target_crew_id, crews);
    const winner = r.winner_user_id ? people.get(r.winner_user_id) ?? null : r.winner_crew_id ? crew : null;
    return {
      id: r.id, type: r.type, type_label: typeInfo?.label ?? r.type,
      from: people.get(r.created_by) ?? null,
      target: r.target_type === 'user' ? { type: 'user', person: people.get(r.target_user_id!) ?? null } : { type: 'crew', crew },
      zone: r.zone_id ? { id: r.zone_id, name: r.zone_name ?? r.zone_id } : null,
      starts_at: r.starts_at, ends_at: r.ends_at, message: r.message, status: r.status,
      direction: r.created_by === viewerId ? 'outgoing' : 'incoming',
      created_at: r.created_at, started_at: r.started_at, completed_at: r.completed_at,
      result: r.status === 'completed' ? { winner, summary: r.result_summary ?? '' } : null,
      actions: r.target_type === 'crew' && (membershipResult.statuses.get(viewerId) === 'unknown' || membershipResult.unavailable || crewResult.unavailable) ? [] : allowedActions(r, {
        isCreator: r.created_by === viewerId,
        isTarget: respondsFor(r, viewerId, membershipResult.memberships),
        isParticipant: participantFor(r, viewerId, crewResult.crews),
      }, Date.now()),
      actions_status: r.target_type === 'crew' && (membershipResult.statuses.get(viewerId) === 'unknown' || membershipResult.unavailable || crewResult.unavailable)
        ? 'crew_role_unavailable' : 'ready',
    };
  });
}

async function participants(r: ChallengeRow): Promise<string[]> {
  const ids = new Set<string>([r.created_by]);
  if (r.target_user_id) ids.add(r.target_user_id);
  if (r.target_crew_id) {
    const crewData = (await lookupCrews([r.target_crew_id])).get(r.target_crew_id);
    if (crewData) for (const m of crewData.members) ids.add(m.subject);
  }
  return [...ids];
}

export async function challengeRoutes(app: FastifyInstance) {
  const IdParam = z.object({ id: z.string().refine(isUuid, 'invalid id') });
  const load = async (id: string) => { const r = await one<ChallengeRow>(`${SELECT} WHERE ch.id = $1`, [id]); if (!r) throw errors.notFound('Challenge'); return r; };
  const emit = async (r: ChallengeRow, created = false) => {
    // `actions` is viewer-specific, so realtime events must serialize once per participant.
    for (const userId of await participants(r)) {
      const [data] = await serializeChallenges([r], userId);
      publish({ type: created ? 'challenge.created' : 'challenge.updated', user_ids: [userId], data });
    }
  };

  for (const base of ['/v1/challenge-invites', '/v1/challenges']) {
    app.get(`${base}/types`, async () => ({ types: CHALLENGE_TYPES }));

    app.get(base, { preHandler: requireAuth }, async (req) => {
      const user = currentUser(req);
      const { box } = z.object({ box: z.enum(['incoming', 'outgoing', 'all']).default('all') }).parse(req.query);
      await expireStale();
      const membershipResult = await lookupCrewMembershipsWithStatus([user.id]);
      const myCrews = (membershipResult.memberships.get(user.id) || []).map(c => c.id);
      const rows = await many<ChallengeRow>(
        `SELECT * FROM (
           ${SELECT} WHERE (
             ($2 IN ('outgoing','all') AND ch.created_by = $1) OR
             ($2 IN ('incoming','all') AND (ch.target_user_id = $1 OR ch.target_crew_id = ANY($3::uuid[])))
           )
           ORDER BY (ch.status IN ('pending','accepted','active')) DESC,
                    CASE WHEN ch.target_type = 'user' THEN 0 ELSE 1 END,
                    ch.created_at DESC
           LIMIT 100
         ) prioritized
         ORDER BY created_at DESC`, [user.id, box, myCrews]);
      const challenges = await serializeChallenges(rows, user.id);
      const callerCrewStatus = membershipResult.statuses.get(user.id) ?? 'unknown';
      return {
        invites: challenges,
        challenges,
        crew_battles_unavailable: callerCrewStatus === 'unknown',
      };
    });

    app.post(base, { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
      const user = currentUser(req);
      const b = CreateBody.parse(req.body ?? {});
      const typeInfo = CHALLENGE_TYPES.find((t) => t.id === b.type)!;
      if (!(typeInfo.targets as readonly string[]).includes(b.target.type)) throw errors.invalid(`${typeInfo.label} cannot target a ${b.target.type}`);
      if (typeInfo.requires_zone && !b.zone_id) throw errors.invalid(`${typeInfo.label} needs a zone`);
      if (b.zone_id && !(await one(`SELECT 1 FROM zones WHERE id = $1 AND is_active`, [b.zone_id]))) throw errors.notFound('Zone');
      if (Date.parse(b.starts_at) < Date.now() - 5 * 60_000) throw errors.invalid('starts_at must be in the future');
      if (b.ends_at && Date.parse(b.ends_at) <= Date.parse(b.starts_at)) throw errors.invalid('ends_at must be after starts_at');
      if (b.target.type === 'user') {
        if (b.target.id === user.id) throw errors.invalid("You can't challenge yourself");
        if (!(await one(`SELECT 1 FROM users WHERE id = $1 AND NOT is_banned`, [b.target.id]))) throw errors.notFound('Squirrel');
        // A block in either direction hides the person (404, as profiles do); Social unreachable → 503 blocks_unreachable.
        if (await isBlockedEitherWay(user.id, b.target.id)) throw errors.notFound('Squirrel');
      } else if (!isUuid(b.target.id) || !(await crewDisplays([b.target.id])).has(b.target.id)) throw errors.notFound('Crew');
      // One open challenge per (creator, target, zone) at a time.
      const dup = await one(`SELECT 1 FROM challenges WHERE created_by = $1 AND status IN ('pending','accepted','active') AND coalesce(target_user_id, target_crew_id::text) = $2 AND coalesce(zone_id, '') = coalesce($3, '')`, [user.id, b.target.id, b.zone_id ?? null]);
      if (dup) throw errors.conflict('challenge_conflict', 'You already have an open challenge with them here.');

      const row = await one<{ id: string }>(
        `INSERT INTO challenges (type, created_by, target_type, target_user_id, target_crew_id, zone_id, starts_at, ends_at, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [b.type, user.id, b.target.type, b.target.type === 'user' ? b.target.id : null, b.target.type === 'crew' ? b.target.id : null, b.zone_id ?? null, b.starts_at, b.ends_at ?? null, b.message ?? null]);
      const r = await load(row!.id);
      await emit(r, true);
      for (const p of (await participants(r)).filter((p) => p !== user.id)) {
        const data = { invite_id: r.id, zone_id: r.zone_id, crew_id: r.target_crew_id,
          route: challengeNotificationRoute(r.zone_id, r.target_crew_id) };
        await notify(p, 'challenge.invitation', '{actor} challenged you', `{actor} challenged you to ${typeInfo.label}${r.zone_name ? ` at ${r.zone_name}` : ''}.`, data, user.id,
          campusNotificationDedupeKey('challenge.invitation', r.id, p));
      }
      reply.code(201);
      return (await serializeChallenges([r], user.id))[0];
    });

    app.patch(`${base}/:id/schedule`, { preHandler: requireAuth }, async (req) => {
      const user = currentUser(req);
      const { id } = IdParam.parse(req.params);
      const b = z.object({ starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }).nullable().optional() }).parse(req.body ?? {});
      const r = await load(id);
      const canSchedule = allowedActions(r, {
        isCreator: r.created_by === user.id,
        isTarget: false,
        isParticipant: false,
      }, Date.now()).includes('schedule');
      if (!canSchedule) {
        if (r.created_by !== user.id) throw errors.forbidden('Only the creator can reschedule.');
        throw errors.conflict('challenge_conflict', `Cannot reschedule a ${r.status} challenge.`);
      }
      await query(`UPDATE challenges SET starts_at = $2, ends_at = $3, updated_at = now() WHERE id = $1`, [id, b.starts_at, b.ends_at ?? null]);
      const fresh = await load(id); await emit(fresh);
      return (await serializeChallenges([fresh], user.id))[0];
    });

    for (const action of ['accept', 'decline', 'cancel', 'start', 'complete'] as const) {
      app.post(`${base}/:id/${action}`, { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
        const user = currentUser(req);
        const { id } = IdParam.parse(req.params);
        const fresh = await withTransaction(async (tx) => {
          const r = await one<ChallengeRow>(`${SELECT} WHERE ch.id = $1 FOR UPDATE OF ch`, [id], tx);
          if (!r) throw errors.notFound('Challenge');
          // Accepting a battle from someone blocked either way is refused as if it did not exist (503 if unknown).
          if (action === 'accept' && r.created_by !== user.id && await isBlockedEitherWay(user.id, r.created_by, tx)) throw errors.notFound('Challenge');
          const isCreator = r.created_by === user.id;
          const membershipResult = await lookupCrewMembershipsWithStatus([user.id]);
          const isTarget = respondsFor(r, user.id, membershipResult.memberships);
          const parts = await participants(r);
          const allowed = allowedActions(r, {
            isCreator,
            isTarget,
            isParticipant: parts.includes(user.id),
          }, Date.now());
          if (!allowed.includes(action)) {
            switch (action) {
              case 'accept':
                if (!isTarget) throw errors.forbidden('Only the invited side can accept.');
                throw errors.conflict('challenge_conflict', `Challenge is ${r.status}.`);
              case 'decline':
                if (!isTarget) throw errors.forbidden('Only the invited side can decline.');
                throw errors.conflict('challenge_conflict', `Challenge is ${r.status}.`);
              case 'cancel':
                if (!isCreator) throw errors.forbidden('Only the creator can cancel.');
                throw errors.conflict('challenge_conflict', `Cannot cancel a ${r.status} challenge.`);
              case 'start':
                if (!parts.includes(user.id)) throw errors.forbidden();
                if (r.status !== 'accepted') throw errors.conflict('challenge_conflict', 'Only accepted challenges can start.');
                throw errors.conflict('challenge_conflict', 'Too early — starts later.');
              case 'complete':
                if (!parts.includes(user.id)) throw errors.forbidden();
                if (r.status !== 'active') throw errors.conflict('challenge_conflict', 'Only active challenges can be completed.');
                throw errors.conflict('challenge_conflict', 'The challenge has not ended yet.');
            }
          }
          let next: ChallengeRow['status'];
          const sets: Record<string, unknown> = {};
          switch (action) {
            case 'accept':
              next = 'accepted'; sets.responded_by = user.id; sets.responded_at = new Date(); break;
            case 'decline':
              next = 'declined'; sets.responded_by = user.id; sets.responded_at = new Date(); break;
            case 'cancel':
              next = 'cancelled'; break;
            case 'start':
              next = 'active'; sets.started_at = new Date(); break;
            case 'complete': {
              next = 'completed'; sets.completed_at = new Date();
              // Server decides the winner from territory state — never from the request body.
              if (r.zone_id && (r.type === 'territory' || r.type === 'zone_race')) {
                const t = await one<{ owner_id: string | null }>(`SELECT owner_id FROM territories WHERE zone_id = $1`, [r.zone_id], tx);
                const owner = t?.owner_id ?? null;
                if (owner && parts.includes(owner)) { sets.winner_user_id = owner; sets.result_summary = `${owner === r.created_by ? 'Challenger' : 'Defender'} holds ${r.zone_name} at the end.`; }
                else sets.result_summary = `Nobody in the challenge holds ${r.zone_name} at the end — draw.`;
              } else if (r.type === 'weekend_war' && r.target_crew_id) {
                const targetCrew = (await lookupCrews([r.target_crew_id])).get(r.target_crew_id);
                const c = await one<{ n: number }>(`SELECT count(*)::int AS n FROM territories WHERE crew_id = $1`, [r.target_crew_id], tx);
                const mineCrewIds = ((await lookupCrewMemberships([r.created_by])).get(r.created_by) || []).map(c => c.id);
                const mine = mineCrewIds.length ? await one<{ n: number }>(`SELECT count(*)::int AS n FROM territories WHERE crew_id = ANY($1::uuid[])`, [mineCrewIds], tx) : { n: 0 };
                const a = mine?.n ?? 0, b2 = c?.n ?? 0;
                if (b2 > a) { sets.winner_crew_id = r.target_crew_id; sets.result_summary = `${targetCrew?.name ?? 'The crew'} holds ${b2} zones vs ${a}.`; }
                else if (a > b2) { sets.winner_user_id = r.created_by; sets.result_summary = `Challenger's crew holds ${a} zones vs ${b2}.`; }
                else sets.result_summary = `Tied at ${a} zones each.`;
              } else {
                sets.result_summary = 'Completed.';
              }
              break;
            }
          }
          const keys = Object.keys(sets);
          await query(`UPDATE challenges SET status = $2, updated_at = now()${keys.map((k, i) => `, ${k} = $${i + 3}`).join('')} WHERE id = $1`, [id, next, ...keys.map((k) => sets[k])], tx);
          return (await one<ChallengeRow>(`${SELECT} WHERE ch.id = $1`, [id], tx))!;
        });
        await emit(fresh);
        const others = (await participants(fresh)).filter((p) => p !== user.id);
        for (const p of others) {
          const verb = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : action === 'cancel' ? 'cancelled' : action === 'start' ? 'started' : 'completed';
          const data = { invite_id: fresh.id, zone_id: fresh.zone_id, crew_id: fresh.target_crew_id,
            route: challengeNotificationRoute(fresh.zone_id, fresh.target_crew_id) };
          await notify(p, 'challenge.updated', 'Challenge updated', `{actor} ${verb} the challenge${fresh.zone_name ? ` at ${fresh.zone_name}` : ''}.`, data, user.id,
            campusNotificationDedupeKey('challenge.updated', fresh.id, p, `${action}:${fresh.updated_at}`));
        }
        return (await serializeChallenges([fresh], user.id))[0];
      });
    }
  }
}

/** Pending invites whose start time passed by > 24 h expire; accepted ones auto-activate at start. */
export async function expireStale() {
  await query(`UPDATE challenges SET status = 'expired', updated_at = now() WHERE status = 'pending' AND starts_at < now() - interval '24 hours'`);
  await query(`UPDATE challenges SET status = 'active', started_at = now(), updated_at = now() WHERE status = 'accepted' AND starts_at <= now()`);
}
