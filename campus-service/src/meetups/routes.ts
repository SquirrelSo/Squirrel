import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one, query, withTransaction } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';
import { currentUser, requireAuth } from '../auth/plugin.js';
import { ApiError, errors } from '../lib/errors.js';
import { isUuid } from '../lib/ids.js';
import { campusNotificationDedupeKey, notify } from '../notifications/service.js';
import { isBlockedEitherWay, getFullBlockSet } from '../blocks/service.js';
import { getPeopleLite, createMissingUsersFromSocial, invalidateUserCache } from '../users/repo.js';
import { awardXpAfterCommit, MEETUP_CHECKIN_XP } from '../run/index.js';

type MeetupStatus = 'proposed' | 'confirmed' | 'cancelled' | 'completed';
type MeetupRow = {
  id: string; created_by: string; zone_id: string | null; place_text: string | null; starts_at: string;
  status: Exclude<MeetupStatus, 'completed'> | MeetupStatus; created_at: string; updated_at: string; zone_name?: string | null;
};
type ParticipantRow = { meetup_id: string; user_id: string; role: 'host' | 'guest'; status: 'invited' | 'accepted' | 'declined'; responded_at: string | null; checked_in_at: string | null };

const CreateBody = z.object({
  zone_id: z.string().trim().min(1).max(64).nullable().optional(),
  place_text: z.string().trim().max(240).nullable().optional(),
  starts_at: z.string().datetime({ offset: true }),
  invitee_ids: z.array(z.string().trim().min(1).max(128)).min(1).max(50),
}).strict().refine((b) => !!b.zone_id || !!b.place_text, { message: 'Provide a zone_id or place_text.' })
  .refine((b) => new Set(b.invitee_ids).size === b.invitee_ids.length, { path: ['invitee_ids'], message: 'Invitee ids must be unique.' });
const IdParams = z.object({ id: z.string().refine(isUuid, 'invalid id') });
const StatusQuery = z.object({ status: z.enum(['proposed', 'confirmed', 'cancelled', 'completed']).optional() });
const EmptyBody = z.object({}).strict();

const RATING_DIMENSIONS = [
  { key: 'friendly', label: 'Friendly & Welcoming' },
  { key: 'punctual', label: 'On Time' },
  { key: 'fun', label: 'Fun to be around' },
  { key: 'helpful', label: 'Helpful' }
];
const RATING_DIMENSION_KEYS = new Set(RATING_DIMENSIONS.map((d) => d.key));

const RatingInputBody = z.object({
  ratings: z.array(z.object({
    user_id: z.string(),
    stars: z.number().int().min(1).max(5),
    tags: z.array(z.string())
  })),
  idempotency_key: z.string().min(1)
}).strict();

type TrustScore = { value: number; label: string };
async function getTrustScore(userId: string, q: Queryable = getPool()): Promise<TrustScore | null> {
  const row = await one<{ raters: number; score: number }>(
    `SELECT count(DISTINCT rater_id)::int AS raters, avg(stars)::float AS score FROM meetup_ratings WHERE ratee_id = $1`, [userId], q
  );
  if (!row || row.raters < 3) return null;
  const value = Math.round(row.score * 10) / 10;
  let label = 'Good';
  if (value >= 4.5) label = 'Excellent';
  else if (value >= 4.0) label = 'Great';
  else if (value >= 3.0) label = 'Good';
  else if (value >= 2.0) label = 'Poor';
  else label = 'Needs Improvement';
  return { value, label };
}

function effectiveStatus(row: MeetupRow): MeetupStatus {
  return row.status === 'confirmed' && Date.parse(row.starts_at) <= Date.now() ? 'completed' : row.status;
}

async function loadMeetup(id: string, q: Queryable = getPool(), lock = false): Promise<MeetupRow | null> {
  return one<MeetupRow>(
    `SELECT m.*, z.name AS zone_name FROM meetups m LEFT JOIN zones z ON z.id = m.zone_id WHERE m.id = $1${lock ? ' FOR UPDATE OF m' : ''}`,
    [id], q,
  );
}

async function participants(meetupId: string, q: Queryable = getPool()) {
  return many<ParticipantRow>(
    `SELECT meetup_id, user_id, role, status, responded_at, checked_in_at FROM meetup_participants WHERE meetup_id = $1 ORDER BY role DESC, user_id`,
    [meetupId], q,
  );
}

async function lockPeople(ids: string[], q: Queryable) {
  await many(`SELECT id FROM users WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [[...new Set(ids)].sort()], q);
}

async function blockedFromViewer(viewerId: string, parts: ParticipantRow[], q?: Queryable) {
  for (const p of parts) {
    if (p.user_id !== viewerId && await isBlockedEitherWay(viewerId, p.user_id, q)) return true;
  }
  return false;
}

async function serialize(row: MeetupRow, viewerId: string, parts?: ParticipantRow[]) {
  const rows = parts ?? await participants(row.id);
  const people = await many<{ id: string; display_name: string; avatar_url: string | null; hostel: string | null; open_to_meet: boolean; open_to_meet_until: string | null }>(
    `SELECT u.id, u.display_name, u.avatar_url, h.short_name AS hostel, u.open_to_meet, u.open_to_meet_until
     FROM users u LEFT JOIN hostels h ON h.id = u.hostel_id WHERE u.id = ANY($1::text[])`, [rows.map((p) => p.user_id)],
  );
  const personMap = new Map(people.map((p) => [p.id, p]));
  const me = rows.find(p => p.user_id === viewerId);
  return {
    id: row.id, created_by: row.created_by, zone_id: row.zone_id,
    zone: row.zone_id ? { id: row.zone_id, name: row.zone_name ?? row.zone_id } : null,
    place_text: row.place_text, starts_at: row.starts_at, status: effectiveStatus(row),
    created_at: row.created_at, updated_at: row.updated_at,
    my_check_in_at: me?.checked_in_at ?? null,
    participants: rows.map((p) => {
      const person = personMap.get(p.user_id);
      return { user_id: p.user_id, role: p.role, status: p.status, responded_at: p.responded_at,
        checked_in: !!p.checked_in_at,
        person: person ? { user_id: person.id, display_name: person.display_name, avatar_url: person.avatar_url, hostel: person.hostel,
          // open_to_meet is exposed as a profile hint only; no meetup decision reads it.
          open_to_meet: person.open_to_meet && (!person.open_to_meet_until || Date.parse(person.open_to_meet_until) > Date.now()) } : null };
    }),
  };
}

async function requireVisibleParticipant(meetupId: string, viewerId: string) {
  const row = await loadMeetup(meetupId);
  if (!row) throw errors.notFound('Meetup');
  const parts = await participants(meetupId);
  if (!parts.some((p) => p.user_id === viewerId) || await blockedFromViewer(viewerId, parts)) throw errors.notFound('Meetup');
  return { row, parts };
}

export async function meetupRoutes(app: FastifyInstance) {
  app.post('/v1/meetups', { preHandler: requireAuth }, async (req, reply) => {
    const host = currentUser(req);
    const body = CreateBody.parse(req.body ?? {});
    if (Date.parse(body.starts_at) <= Date.now()) throw errors.invalid('starts_at must be in the future.');
    if (body.invitee_ids.includes(host.id)) throw errors.invalid('You cannot invite yourself.');
    if (body.zone_id && !(await one(`SELECT 1 FROM zones WHERE id = $1 AND is_active`, [body.zone_id]))) throw errors.notFound('Zone');
    let users = await many<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::text[]) AND NOT is_banned`, [body.invitee_ids]);
    if (users.length !== body.invitee_ids.length) {
      const missingIds = body.invitee_ids.filter(id => !users.some(u => u.id === id));
      const socialNames = await createMissingUsersFromSocial(missingIds);
      users = await many<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::text[]) AND NOT is_banned`, [body.invitee_ids]);
      if (users.length !== body.invitee_ids.length) {
        const stillMissingIds = body.invitee_ids.filter(id => !users.some(u => u.id === id));
        const missingLabels = stillMissingIds.map(id => socialNames.get(id) ?? `User ${id.slice(0, 6)}`);
        // Not errors.notFound(): that appends " not found" to the text, which is a full sentence here.
        throw new ApiError(404, 'not_found', `${missingLabels.join(', ')} hasn't used the campus map yet`);
      }
    }

    const created = await withTransaction(async (tx) => {
      await lockPeople([host.id, ...body.invitee_ids], tx);
      const participantIds = [host.id, ...body.invitee_ids];
      for (let i = 0; i < participantIds.length; i++) for (let j = i + 1; j < participantIds.length; j++) {
        if (await isBlockedEitherWay(participantIds[i]!, participantIds[j]!, tx)) throw errors.conflict('meetup_blocked', 'You cannot invite someone who has blocked you or whom you have blocked.');
      }
      const meetup = await one<MeetupRow>(
        `INSERT INTO meetups (created_by, zone_id, place_text, starts_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [host.id, body.zone_id ?? null, body.place_text?.trim() || null, body.starts_at], tx,
      );
      await query(`INSERT INTO meetup_participants (meetup_id, user_id, role, status, responded_at) VALUES ($1, $2, 'host', 'accepted', now())`, [meetup!.id, host.id], tx);
      for (const id of body.invitee_ids) {
        await query(`INSERT INTO meetup_participants (meetup_id, user_id, role, status) VALUES ($1, $2, 'guest', 'invited')`, [meetup!.id, id], tx);
      }
      return meetup!;
    });
    for (const id of body.invitee_ids) await notify(id, 'meetup.invited', 'Meetup invitation', '{actor} invited you to a meetup.',
      { meetup_id: created.id, route: `/meetup/${created.id}` }, host.id, campusNotificationDedupeKey('meetup.invited', created.id, id));
    reply.code(201);
    const fresh = await loadMeetup(created.id);
    return serialize(fresh!, host.id);
  });

  app.get('/v1/meetups', { preHandler: requireAuth }, async (req) => {
    const viewer = currentUser(req);
    const { status } = StatusQuery.parse(req.query);
    const rows = await many<MeetupRow>(
      `SELECT m.*, z.name AS zone_name FROM meetups m
       JOIN meetup_participants mp ON mp.meetup_id = m.id
       LEFT JOIN zones z ON z.id = m.zone_id
       WHERE mp.user_id = $1 ORDER BY m.starts_at, m.created_at DESC LIMIT 100`, [viewer.id],
    );
    const out = [];
    for (const row of rows) {
      const parts = await participants(row.id);
      if (await blockedFromViewer(viewer.id, parts)) continue;
      if (status && effectiveStatus(row) !== status) continue;
      out.push(await serialize(row, viewer.id, parts));
    }
    return { meetups: out };
  });

  app.get('/v1/meetups/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { row, parts } = await requireVisibleParticipant(id, currentUser(req).id);
    return serialize(row, currentUser(req).id, parts);
  });

  for (const action of ['accept', 'decline', 'cancel', 'leave'] as const) {
    app.post(`/v1/meetups/:id/${action}`, { preHandler: requireAuth }, async (req) => {
      EmptyBody.parse(req.body ?? {});
      const user = currentUser(req);
      const { id } = IdParams.parse(req.params);
      const result = await withTransaction(async (tx) => {
        const row = await loadMeetup(id, tx, true);
        if (!row) throw errors.notFound('Meetup');
        const parts = await participants(id, tx);
        const actor = parts.find((p) => p.user_id === user.id);
        if (!actor) throw errors.notFound('Meetup');
        await lockPeople(parts.map((p) => p.user_id), tx);
        if (action === 'accept' && await blockedFromViewer(user.id, parts, tx)) throw errors.notFound('Meetup');
        const status = effectiveStatus(row);
        let cancelledByResponses = false;

        if (action === 'accept' || action === 'decline') {
          if (actor.role !== 'guest') throw errors.notFound('Meetup');
          if (action === 'accept' && actor.status !== 'invited' && actor.status !== 'declined') throw errors.notFound('Meetup');
          if (action === 'decline' && actor.status !== 'invited') throw errors.notFound('Meetup');
          if (row.status === 'cancelled' || status === 'completed') throw errors.conflict('meetup_closed', 'This meetup is no longer open for responses.');
          if (action === 'accept') {
            await query(`UPDATE meetup_participants SET status = 'accepted', responded_at = now() WHERE meetup_id = $1 AND user_id = $2`, [id, user.id], tx);
            await query(`UPDATE meetups SET status = 'confirmed', updated_at = now() WHERE id = $1`, [id], tx);
          } else {
            await query(`UPDATE meetup_participants SET status = 'declined', responded_at = now() WHERE meetup_id = $1 AND user_id = $2`, [id, user.id], tx);
          }
        } else if (action === 'cancel') {
          if (actor.role !== 'host') throw errors.notFound('Meetup');
          if (status === 'completed' || row.status === 'cancelled') throw errors.conflict('meetup_closed', 'A completed or cancelled meetup cannot be cancelled.');
          await query(`UPDATE meetups SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id], tx);
        } else {
          if (actor.role !== 'guest') throw errors.notFound('Meetup');
          if (actor.status !== 'accepted') throw errors.conflict('meetup_participant_state', 'Only an accepted guest can leave.');
          await query(`UPDATE meetup_participants SET status = 'declined', responded_at = now() WHERE meetup_id = $1 AND user_id = $2`, [id, user.id], tx);
        }
        return { row: (await loadMeetup(id, tx))!, parts: await participants(id, tx), cancelledByResponses };
      });

      if (action === 'accept') await notify(result.row.created_by, 'meetup.accepted', 'Meetup accepted', '{actor} accepted your meetup invitation.',
        { meetup_id: id, status: 'accepted', route: `/meetup/${id}` }, user.id,
        campusNotificationDedupeKey('meetup.accepted', id, result.row.created_by, result.row.updated_at));
      if (action === 'decline' || action === 'leave') await notify(result.row.created_by, 'meetup.declined', 'Meetup response', action === 'leave' ? '{actor} is no longer attending your meetup.' : '{actor} declined your meetup invitation.',
        { meetup_id: id, status: 'declined', route: `/meetup/${id}` }, user.id,
        campusNotificationDedupeKey('meetup.declined', id, result.row.created_by, `${action}:${result.row.updated_at}`));
      if ((action === 'decline' || action === 'leave') && result.cancelledByResponses) {
        await notify(result.row.created_by, 'meetup.cancelled', 'Meetup cancelled', '{actor} declined or withdrew, so the meetup was cancelled.',
          { meetup_id: id, status: 'cancelled', route: `/meetup/${id}` }, user.id,
          campusNotificationDedupeKey('meetup.cancelled', id, result.row.created_by, `all_declined:${result.row.updated_at}`));
      }
      if (action === 'cancel') {
        for (const p of result.parts.filter((p) => p.role === 'guest' && p.status !== 'declined')) {
          await notify(p.user_id, 'meetup.cancelled', 'Meetup cancelled', '{actor} cancelled the meetup.',
            { meetup_id: id, status: 'cancelled', route: `/meetup/${id}` }, user.id,
            campusNotificationDedupeKey('meetup.cancelled', id, p.user_id, `host_cancel:${result.row.updated_at}`));
        }
      }
      return serialize(result.row, user.id, result.parts);
    });
  }


  app.post('/v1/meetups/:id/check-in', { preHandler: requireAuth }, async (req) => {
    const viewer = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const body = z.object({ notify_safety_contact: z.boolean().default(false) }).parse(req.body ?? {});
  
    const scope = `meetup-checkin:${id}`;
    const replay = await one<{ response: any; scope: string }>(
      `SELECT response, scope FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [viewer.id, id]
    );
    if (replay) {
      if (replay.scope !== scope) throw errors.conflict('idempotency_key_reused', 'Idempotency key reused for a different request.');
      return replay.response;
    }
  
    let xpAwardees: string[] = [];
    const out = await withTransaction(async (tx) => {
      const row = await loadMeetup(id, tx, true);
      if (!row) throw errors.notFound('Meetup');
      
      const parts = await participants(id, tx);
      if (await blockedFromViewer(viewer.id, parts, tx)) throw errors.notFound('Meetup');
  
      const me = parts.find((p) => p.user_id === viewer.id);
      if (!me) throw errors.notFound('Meetup');
      if (row.status === 'cancelled') throw errors.conflict('meetup_closed', 'This meetup was cancelled.');
      if (me.status === 'declined') throw errors.conflict('meetup_not_participant', 'Only attendees can check in.');
  
      const startMs = Date.parse(row.starts_at);
      if (Date.now() < startMs - 3600_000 || Date.now() > startMs + 6 * 3600_000) {
        throw errors.conflict('meetup_checkin_closed', 'Check-in is only available between 1 hour before and 6 hours after the meetup.');
      }
      
      if (me.status === 'invited') {
        // Checking in is an implicit accept, so it confirms a proposed meetup exactly as /accept does.
        // Without this a meetup whose guests only checked in stayed `proposed`, never became
        // `completed`, and could never be rated.
        await query(`UPDATE meetup_participants SET status = 'accepted', responded_at = now(), checked_in_at = now() WHERE meetup_id = $1 AND user_id = $2`, [id, viewer.id], tx);
        await query(`UPDATE meetups SET status = 'confirmed', updated_at = now() WHERE id = $1 AND status = 'proposed'`, [id], tx);
      } else {
        await query(`UPDATE meetup_participants SET checked_in_at = now() WHERE meetup_id = $1 AND user_id = $2`, [id, viewer.id], tx);
      }
      
      const res = { 
        meetup_id: id, 
        checked_in_at: new Date().toISOString(), 
        safety_notification: { requested: body.notify_safety_contact, status: body.notify_safety_contact ? 'not_configured' : 'skipped', contact_label: null } 
      };
  
      await query(`INSERT INTO idempotency_keys (user_id, key, scope, status_code, response) VALUES ($1, $2, $3, 200, $4) ON CONFLICT DO NOTHING`, [viewer.id, id, scope, res], tx);

      // meetup_checkin XP: once at least two participants have checked in. The meetup row is locked, so
      // check-ins are serialised: the second check-in awards both, every later one awards only itself.
      if (!me.checked_in_at) {
        const checkedIn = (await participants(id, tx)).filter((p) => p.checked_in_at && p.status !== 'declined').map((p) => p.user_id);
        if (checkedIn.length === 2) xpAwardees = checkedIn;
        else if (checkedIn.length > 2) xpAwardees = [viewer.id];
      }
      
      for (const p of parts) {
        if (p.user_id !== viewer.id && (p.status === 'accepted' || (me.status === 'invited' && p.user_id === viewer.id /* self updated */))) {
          // If a user just accepted via check-in, they aren't in 'parts' as accepted yet, but we only notify *other* attendees anyway.
          await notify(p.user_id, 'meetup.check_in', 'Meetup check-in', '{actor} checked in for the meetup.',
            { meetup_id: id, route: `/meetup/${id}` }, viewer.id,
            campusNotificationDedupeKey('meetup.check_in', id, p.user_id));
        }
      }
      
      return res;
    });
    // After commit, fire-and-forget (contract §1): the check-in never waits on or fails with the Run Module.
    for (const subject of xpAwardees) {
      void awardXpAfterCommit(subject, MEETUP_CHECKIN_XP, 'meetup_checkin', `meetup:${id}:${subject}`, { source_id: id })
        .then(() => invalidateUserCache(subject));
    }
    return out;
  });

  app.get('/v1/meetups/:id/rating', { preHandler: requireAuth }, async (req) => {
    const viewer = currentUser(req);
    const { id } = IdParams.parse(req.params);
    
    const row = await loadMeetup(id);
    if (!row) throw errors.notFound('Meetup');
    const parts = await participants(id);
    const me = parts.find((p) => p.user_id === viewer.id);
    if (!me) throw errors.notFound('Meetup');
    
    const status = effectiveStatus(row);
    const trust_score = await getTrustScore(viewer.id, getPool());
    
    const already_rated = await one<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM meetup_ratings WHERE meetup_id = $1 AND rater_id = $2) AS exists`, [id, viewer.id]
    ).then(r => r?.exists ?? false);
  
    if (status !== 'completed') {
      return { meetup_id: id, can_rate: false, reason: 'This meetup has not ended yet.', already_rated, rateable: [], dimensions: RATING_DIMENSIONS, trust_score };
    }
    
    if (me.status !== 'accepted') {
      return { meetup_id: id, can_rate: false, reason: 'You did not attend this meetup.', already_rated, rateable: [], dimensions: RATING_DIMENSIONS, trust_score };
    }
  
    const blocks = await getFullBlockSet(viewer.id);
    const rateableIds = parts.filter(p => p.user_id !== viewer.id && p.status === 'accepted' && !blocks.has(p.user_id)).map(p => p.user_id);
    
    const rateable = [];
    if (rateableIds.length > 0) {
      const people = await getPeopleLite(rateableIds);
      for (const uid of rateableIds) {
        const p = people.get(uid);
        if (p) rateable.push(p);
      }
    }
  
    return { meetup_id: id, can_rate: true, reason: null, already_rated, rateable, dimensions: RATING_DIMENSIONS, trust_score };
  });

  app.post('/v1/meetups/:id/ratings', { preHandler: requireAuth }, async (req) => {
    const viewer = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const body = RatingInputBody.parse(req.body);
  
    const scope = `meetup-rating:${id}`;
    const replay = await one<{ response: any; scope: string }>(
      `SELECT response, scope FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [viewer.id, body.idempotency_key]
    );
    if (replay) {
      if (replay.scope !== scope) throw errors.conflict('idempotency_key_reused', 'Idempotency key reused for a different request.');
      return replay.response;
    }
  
    return await withTransaction(async (tx) => {
      const existing = await one<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM meetup_ratings WHERE meetup_id = $1 AND rater_id = $2) AS exists`, [id, viewer.id], tx);
      if (existing?.exists) throw errors.conflict('already_rated', 'You have already rated this meetup.');
      
      const row = await loadMeetup(id, tx, true);
      if (!row) throw errors.notFound('Meetup');
      if (effectiveStatus(row) !== 'completed') throw errors.conflict('meetup_not_completed', 'Meetup must be completed to rate.');
  
      const parts = await participants(id, tx);
      const me = parts.find((p) => p.user_id === viewer.id);
      if (!me || me.status !== 'accepted') throw errors.conflict('meetup_not_participant', 'Only participants can rate.');
  
      const blocks = await getFullBlockSet(viewer.id, tx);
      const validRateeIds = new Set(parts.filter(p => p.user_id !== viewer.id && p.status === 'accepted').map(p => p.user_id));
  
      for (const r of body.ratings) {
        if (r.user_id === viewer.id) throw errors.conflict('self_rating', 'You cannot rate yourself.');
        if (!validRateeIds.has(r.user_id)) throw errors.conflict('invalid_ratee', 'You can only rate accepted participants of this meetup.');
        if (blocks.has(r.user_id)) throw errors.conflict('meetup_blocked', 'Cannot rate a blocked user.');
        
        const validTags = r.tags.filter(t => RATING_DIMENSION_KEYS.has(t));
        await query(
          `INSERT INTO meetup_ratings (meetup_id, rater_id, ratee_id, stars, tags) VALUES ($1, $2, $3, $4, $5)`,
          [id, viewer.id, r.user_id, r.stars, validTags], tx
        );
      }
  
      const trust_score = await getTrustScore(viewer.id, tx);
      const res = { meetup_id: id, submitted_at: new Date().toISOString(), trust_score };
  
      await query(`INSERT INTO idempotency_keys (user_id, key, scope, status_code, response) VALUES ($1, $2, $3, 200, $4) ON CONFLICT DO NOTHING`, [viewer.id, body.idempotency_key, scope, res], tx);
      return res;
    });
  });
}
