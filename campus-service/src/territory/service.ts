/**
 * Claim / steal / defend. The only code path that changes territory ownership.
 *
 * Concurrency model:
 *   BEGIN
 *     SELECT users        WHERE id = actor   FOR UPDATE   -- serialises one user's actions (cooldown, idempotency)
 *     SELECT territories  WHERE zone_id = z  FOR UPDATE   -- serialises all actions on one zone
 *     SELECT qualification (live, QUALIFIED)  FOR UPDATE   -- so it can be consumed exactly once
 *     re-evaluate rules against the LOCKED state          -- never the state the client saw
 *     UPDATE territories ... WHERE zone_id = z AND version = <locked version>   -- belt and braces
 *     INSERT territory_events; UPDATE qualification -> CLAIMED; award XP; store idempotency
 *   COMMIT
 * `territories.zone_id` is the primary key, so two owners for one zone is unrepresentable.
 */
import type pg from 'pg';
import { config } from '../config.js';
import { withTransaction, one, many, query } from '../db/pool.js';
import { ApiError, errors } from '../lib/errors.js';
import { addHours } from '../lib/time.js';
import { publish } from '../realtime/bus.js';
import { campusNotificationDedupeKey, notify } from '../notifications/service.js';
import { isBlockedEitherWay } from '../blocks/service.js';
import { getPersonLite, touchTerritoryAction, invalidateUserCache, type UserRow } from '../users/repo.js';
import { getZone, type ZoneRow } from '../zones/repo.js';
import { computeActions, type ZoneActions } from './rules.js';
import { getTerritory, serializeTerritory, territoryOut, serializeEvents, type TerritoryEventRow, type TerritoryRow } from './repo.js';

export type TerritoryAction = 'claim' | 'steal' | 'defend';

type LiveQualification = { id: string; expires_at: string; activity_id: string };

export async function liveQualification(userId: string, zoneId: string, q: pg.PoolClient | pg.Pool, lock = false) {
  return one<LiveQualification>(
    `SELECT id, expires_at, activity_id FROM qualification_results
     WHERE user_id = $1 AND zone_id = $2 AND status = 'QUALIFIED' AND expires_at > now()
     ORDER BY expires_at DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
    [userId, zoneId], q,
  );
}

export async function hasPendingVerification(userId: string, zoneId: string, q: pg.PoolClient | pg.Pool) {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM activities a JOIN zones z ON z.id = $2
     WHERE a.user_id = $1 AND a.verification_status IN ('PENDING','PROCESSING') AND a.raw_track IS NOT NULL AND ST_Intersects(a.raw_track, z.geometry)`,
    [userId, zoneId], q,
  );
  return (r?.n ?? 0) > 0;
}

import { lookupCrewMemberships, lookupCrews } from '../identity/index.js';

export async function isCrewMember(userId: string, crewId: string | null, q: pg.PoolClient | pg.Pool) {
  if (!crewId) return false;
  const memberships = (await lookupCrewMemberships([userId])).get(userId) || [];
  return memberships.some(c => c.id === crewId);
}

export async function primaryCrewId(userId: string, q: pg.PoolClient | pg.Pool) {
  const memberships = (await lookupCrewMemberships([userId])).get(userId) || [];
  if (memberships.length === 0) return null;
  
  // They are ordered by oldest membership first by Social
  return memberships[0].id;
}

/** The server's answer to "what can this user do here?" — used by every read endpoint. */
export async function actionsFor(user: UserRow | null, zone: ZoneRow, territory: TerritoryRow, q: pg.PoolClient | pg.Pool): Promise<ZoneActions> {
  const anon = { allowed: false, code: 'unauthorized', reason: 'Sign in to claim territory.', expires_at: null };
  if (!user) return { claim: anon, steal: anon, defend: anon };
  const [qual, pending, crew] = await Promise.all([
    liveQualification(user.id, zone.id, q),
    hasPendingVerification(user.id, zone.id, q),
    isCrewMember(user.id, territory.crew_id, q),
  ]);
  return computeActions({
    now: new Date(), userId: user.id,
    zone: { id: zone.id, name: zone.name, is_active: zone.is_active },
    territory: { owner_id: territory.owner_id, crew_id: territory.crew_id, shield_until: territory.shield_until, last_defended_at: territory.last_defended_at, under_challenge: territory.under_challenge },
    qualification: qual ? { id: qual.id, expires_at: qual.expires_at } : null,
    pendingVerification: pending, isCrewMember: crew, lastTerritoryActionAt: user.last_territory_action_at,
  });
}

export type ActionResult = { territory: ReturnType<typeof serializeTerritory>; actions: ZoneActions; event: Awaited<ReturnType<typeof serializeEvents>>[number] | null; replayed?: boolean };

export async function performTerritoryAction(user: UserRow, zoneId: string, action: TerritoryAction, idempotencyKey: string): Promise<ActionResult> {
  if (!idempotencyKey || idempotencyKey.length > 200) throw errors.invalid('idempotency_key is required (≤ 200 chars)');
  const scope = `territory:${action}:${zoneId}`;

  // Fast path: a completed replay never re-enters the transaction.
  const replay = await one<{ response: ActionResult; scope: string; status_code: number }>(`SELECT response, scope, status_code FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [user.id, idempotencyKey]);
  if (replay) return replayResponse(replay, scope);

  type Committed = { result: ActionResult; event: TerritoryEventRow; previousOwnerId: string | null; zone: ZoneRow };
  const committed = await withTransaction<Committed>(async (tx) => {
    // 1. Lock the actor row, then the zone row (fixed order → no deadlocks between actors).
    const actor = await one<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [user.id], tx);
    if (!actor) throw errors.unauthorized();
    if (actor.is_banned) throw errors.forbidden('This account is suspended.');

    const replayInTx = await one<{ response: ActionResult; scope: string; status_code: number }>(`SELECT response, scope, status_code FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [user.id, idempotencyKey], tx);
    if (replayInTx) return { result: replayResponse(replayInTx, scope), event: null as unknown as TerritoryEventRow, previousOwnerId: null, zone: null as unknown as ZoneRow };

    const zone = await getZone(zoneId, tx);
    if (!zone) throw errors.notFound('Zone');
    const territory = await getTerritory(zoneId, tx, true);
    if (!territory) throw errors.notFound('Territory');

    // 2. Independently re-derive eligibility from locked state. Client flags are never consulted.
    const qual = await liveQualification(actor.id, zoneId, tx, true);
    const [pending, crewMember] = await Promise.all([hasPendingVerification(actor.id, zoneId, tx), isCrewMember(actor.id, territory.crew_id, tx)]);
    const actions = computeActions({
      now: new Date(), userId: actor.id,
      zone: { id: zone.id, name: zone.name, is_active: zone.is_active },
      territory: { owner_id: territory.owner_id, crew_id: territory.crew_id, shield_until: territory.shield_until, last_defended_at: territory.last_defended_at, under_challenge: territory.under_challenge },
      qualification: qual ? { id: qual.id, expires_at: qual.expires_at } : null,
      pendingVerification: pending, isCrewMember: crewMember, lastTerritoryActionAt: actor.last_territory_action_at,
    });
    const avail = actions[action];
    if (!avail.allowed) {
      const status = avail.code === 'zone_inactive' ? 404 : avail.code === 'unauthorized' ? 401 : avail.code === 'cooldown' || avail.code === 'defend_cooldown' ? 429 : 409;
      throw new ApiError(status, avail.code ?? 'not_allowed', avail.reason ?? 'Not allowed right now', { expires_at: avail.expires_at });
    }
    if (!qual) throw errors.conflict('not_qualified', 'No live qualification'); // defensive: rules guarantee this

    // 3. Apply the transition.
    const now = new Date();
    const shieldUntil = addHours(now, config.rules.claimShieldHours);
    const previousOwnerId = territory.owner_id;

    const nextVersion = territory.version + 1;
    let xp = 0;
    let dbAction: TerritoryEventRow['action'];
    let updated: TerritoryRow | null;

    if (action === 'defend') {
      xp = config.rules.xpDefend;
      dbAction = 'DEFEND';
      updated = await one<TerritoryRow>(
        `UPDATE territories SET defense_count = defense_count + 1, last_defended_at = $2, shield_until = $3, xp = xp + $4, version = $5, updated_at = $2
         WHERE zone_id = $1 AND version = $6 RETURNING *`,
        [zoneId, now, shieldUntil, xp, nextVersion, territory.version], tx,
      );
      // The attack was repelled: rivals' live qualifications on this zone are spent.
      await query(`UPDATE qualification_results SET status = 'EXPIRED' WHERE zone_id = $1 AND status = 'QUALIFIED' AND user_id <> $2`, [zoneId, actor.id], tx);
    } else {
      xp = action === 'steal' ? config.rules.xpSteal : config.rules.xpClaim;
      dbAction = action === 'steal' ? 'STEAL' : 'CLAIM';
      const crewId = await primaryCrewId(actor.id, tx);
      updated = await one<TerritoryRow>(
        `UPDATE territories SET owner_id = $2, owner_type = 'USER', crew_id = $3, status = 'CLAIMED', claimed_at = $4, shield_until = $5,
           defense_count = 0, last_defended_at = NULL, claim_count = claim_count + 1, xp = $6, version = $7, updated_at = $4
         WHERE zone_id = $1 AND version = $8 RETURNING *`,
        [zoneId, actor.id, crewId, now, shieldUntil, xp, nextVersion, territory.version], tx,
      );
    }
    if (!updated) throw errors.conflict('territory_conflict', 'The territory changed while processing your request. Refresh and try again.');

    const event = await one<TerritoryEventRow>(
      `INSERT INTO territory_events (zone_id, action, actor_id, previous_owner_id, new_owner_id, triggered_by_activity_id, qualification_id, xp_awarded, territory_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [zoneId, dbAction, actor.id, previousOwnerId, action === 'defend' ? previousOwnerId : actor.id, qual.activity_id, qual.id, xp, nextVersion], tx,
    );
    // 4. Spend the qualification; award XP; start the cooldown.
    await query(`UPDATE qualification_results SET status = 'CLAIMED', claim_available = false, consumed_by_event_id = $2 WHERE id = $1`, [qual.id, event!.id], tx);
    
    await touchTerritoryAction(actor.id, tx);

    const fresh = (await getTerritory(zoneId, tx))!;
    const owner = await getPersonLite(fresh.owner_id, tx);
    const freshActions = await actionsFor({ ...actor, last_territory_action_at: now.toISOString() }, zone, fresh, tx);
    const [serializedEvent] = await serializeEvents([event!], tx);
    const result: ActionResult = { territory: await territoryOut(fresh, owner), actions: freshActions, event: serializedEvent ?? null };
    await query(`INSERT INTO idempotency_keys (user_id, key, scope, status_code, response) VALUES ($1, $2, $3, 200, $4) ON CONFLICT DO NOTHING`, [actor.id, idempotencyKey, scope, result], tx);
    return { result, event: event!, previousOwnerId, zone };
  });

  invalidateUserCache(user.id);
  if (committed.result.replayed) return committed.result;

  try {
    const { awardXp } = await import('../run/index.js');
    const newTotal = await awardXp(user.id, committed.event.xp_awarded, action === 'steal' ? 'territory_steal' : action === 'defend' ? 'territory_defend' : 'territory_claim', idempotencyKey);
    if (newTotal !== null) {
      await query(`UPDATE users SET xp_total = $2, xp_synced_at = now(), updated_at = now() WHERE id = $1`, [user.id, newTotal]);
      invalidateUserCache(user.id);
    }
  } catch (err) {
    console.error('Failed to award territory XP to run module. Claim succeeded, xp_synced_at left stale.', err);
  }

  // 5. Side effects after commit: realtime + notifications.
  const t = committed.result.territory;
  const eventType = action === 'defend' ? 'territory.defended' : action === 'steal' ? 'territory.stolen' : 'territory.claimed';
  publish({ type: eventType, zone_id: zoneId, data: t });
  const zoneName = committed.zone.name;
  if (action === 'steal' && committed.previousOwnerId) {
    await notify(committed.previousOwnerId, 'territory.stolen', '{actor} stole your territory', `${zoneName} is yours to win back.`, { zone_id: zoneId, route: `/zone/${zoneId}` }, user.id,
      campusNotificationDedupeKey('territory.stolen', committed.event.id, committed.previousOwnerId));
  }
  if (action === 'defend') {
    // Everyone whose attack was repelled learns the zone was defended.
    const rivals = await many<{ user_id: string }>(`SELECT DISTINCT user_id FROM qualification_results WHERE zone_id = $1 AND status = 'EXPIRED' AND user_id <> $2 AND evaluated_at > now() - interval '48 hours'`, [zoneId, user.id]);
    for (const r of rivals) await notify(r.user_id, 'territory.defended', 'Your territory was defended', `{actor} defended ${zoneName}.`, { zone_id: zoneId, route: `/zone/${zoneId}` }, user.id,
      campusNotificationDedupeKey('territory.defended', committed.event.id, r.user_id));
  }
  if (action === 'claim') {
    // Crew mates get a heads-up that the crew gained ground.
    const mates: { user_id: string }[] = [];
    if (t.crew?.id) {
      const crewData = (await lookupCrews([t.crew.id])).get(t.crew.id);
      if (crewData) {
        mates.push(...crewData.members.filter(m => m.subject !== user.id).map(m => ({ user_id: m.subject })));
      }
    }
    for (const m of mates) await notify(m.user_id, 'zone.claimed', '{actor} claimed a crew zone', `${zoneName} is now held by your crew.`, { zone_id: zoneId, route: `/zone/${zoneId}` }, user.id,
      campusNotificationDedupeKey('zone.claimed', committed.event.id, m.user_id));
  }
  return committed.result;
}

function replayResponse(row: { response: ActionResult; scope: string; status_code: number }, scope: string): ActionResult {
  if (row.scope !== scope) throw errors.conflict('idempotency_key_reused', 'This idempotency key was already used for a different request.');
  return { ...row.response, replayed: true };
}
