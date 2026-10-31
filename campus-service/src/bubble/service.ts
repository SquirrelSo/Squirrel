/**
 * Bubble: an ephemeral proximity layer. Joining reduces the caller's position to a coarse grid cell
 * (cells.ts) and the zone containing it, then forgets the coordinates. Members see other members in
 * their 3×3 cell neighbourhood who are Open to Meet and not blocked in either direction.
 *
 * Nothing here ever returns, logs or stores coordinates or distances: proximity is a cell bucket.
 * Membership requires a current Open to Meet (the discoverability opt-in) and lapses after
 * BUBBLE_TTL_MINUTES unless refreshed by another join; the sweeper deletes lapsed rows.
 */
import pino from 'pino';
import { config } from '../config.js';
import { getPool, many, one, query, withTransaction, type Queryable } from '../db/pool.js';
import { getFullBlockSet } from '../blocks/service.js';
import { publish, type BubbleEventType } from '../realtime/bus.js';
import { campusNotificationDedupeKey, notify } from '../notifications/service.js';
import { tiebreak, type SortKey } from '../lib/pagination.js';
import { cellFor, cellProximity, neighbourhood } from './cells.js';

const log = pino({ level: config.logLevel, name: 'bubble' });

export type ActivityType = 'run' | 'walk' | 'workout';
export const BUBBLE_STATES = ['nearby', 'active_nearby', 'recently_active', 'same_zone', 'same_campus', 'same_activity'] as const;
export type BubbleState = (typeof BUBBLE_STATES)[number];
export type Proximity = 'very_close' | 'nearby' | 'on_campus';

/** Consent as stored: Open to Meet on and not lapsed. Used in SQL wherever people are listed. */
export const OPEN_NOW_SQL = (alias: string) => `(${alias}.open_to_meet AND (${alias}.open_to_meet_until IS NULL OR ${alias}.open_to_meet_until > now()))`;

export function isOpenNow(u: { open_to_meet: boolean; open_to_meet_until: string | null }): boolean {
  return u.open_to_meet && (!u.open_to_meet_until || Date.parse(u.open_to_meet_until) > Date.now());
}

/** Fresh consent from the database (the request's cached user row may be up to 5 s old). */
export async function openNow(userId: string, q: Queryable = getPool()): Promise<boolean> {
  const r = await one<{ open: boolean }>(`SELECT ${OPEN_NOW_SQL('u')} AND NOT u.is_banned AS open FROM users u WHERE u.id = $1`, [userId], q);
  return !!r?.open;
}

export type MemberRow = { user_id: string; cell: string; zone_id: string | null; zone_name: string | null; activity_type: ActivityType | null; joined_at: string; refreshed_at: string; expires_at: string };

export async function liveMembership(userId: string, q: Queryable = getPool()): Promise<MemberRow | null> {
  return one<MemberRow>(
    `SELECT b.user_id, b.cell, b.zone_id, z.name AS zone_name, b.activity_type, b.joined_at, b.refreshed_at, b.expires_at
     FROM bubble_members b LEFT JOIN zones z ON z.id = b.zone_id WHERE b.user_id = $1 AND b.expires_at > now()`, [userId], q);
}

/** The smallest active zone containing the point (the point itself is not kept). */
export async function zoneAt(lat: number, lng: number, q: Queryable = getPool()): Promise<{ id: string; name: string } | null> {
  return one<{ id: string; name: string }>(
    `SELECT id, name FROM zones WHERE is_active AND ST_Contains(geometry, ST_SetSRID(ST_MakePoint($2, $1), 4326))
     ORDER BY ST_Area(geometry), id LIMIT 1`, [lat, lng], q);
}

/** My live activity: an ongoing recorded activity (presence) first, else the type declared on join. */
async function myActivity(userId: string, declared: ActivityType | null): Promise<ActivityType | null> {
  const p = await one<{ activity_type: ActivityType | null }>(`SELECT activity_type FROM presence WHERE user_id = $1 AND expires_at > now()`, [userId]);
  return p?.activity_type ?? declared;
}

// ---------------------------------------------------------------------------------------------
// People cards (shared with Discover)
// ---------------------------------------------------------------------------------------------

/** One person who may be listed, before block filtering. Never carries a position or a distance. */
export type Candidate = {
  user_id: string; display_name: string; avatar_url: string | null; hostel: string | null; connection_mode: string | null; bio: string | null;
  xp_total: number; xp_synced_at: string;
  live_activity: ActivityType | null; live_activity_started_at: string | null; declared_activity: ActivityType | null;
  zone_id: string | null; zone_name: string | null;
  proximity: Proximity | null; last_seen_at: string; recently_active: boolean;
};

export type PersonItem = {
  person: { user_id: string; display_name: string; avatar_url: string | null; hostel: string | null; connection_mode: string | null; bio: string | null; level: number; xp: number };
  activity: { type: ActivityType; started_at: string | null } | null;
  proximity: Proximity | null;
  zone: { id: string; name: string } | null;
  states: BubbleState[];
  last_seen_at: string;
};

export type Viewer = { zone_id: string | null; activity: ActivityType | null; inNeighbourhood: boolean };

export function activityOf(c: Candidate): PersonItem['activity'] {
  if (c.live_activity) return { type: c.live_activity, started_at: c.live_activity_started_at };
  if (c.declared_activity) return { type: c.declared_activity, started_at: null };
  return null;
}

export function toItem(c: Candidate, viewer: Viewer): PersonItem {
  const activity = activityOf(c);
  const states: BubbleState[] = [];
  const near = viewer.inNeighbourhood && (c.proximity === 'very_close' || c.proximity === 'nearby');
  if (near) states.push('nearby');
  if (near && activity) states.push('active_nearby');
  if (!activity && c.recently_active) states.push('recently_active');
  if (viewer.zone_id && c.zone_id === viewer.zone_id) states.push('same_zone');
  states.push('same_campus');
  if (viewer.activity && activity?.type === viewer.activity) states.push('same_activity');
  return {
    person: { user_id: c.user_id, display_name: c.display_name, avatar_url: c.avatar_url, hostel: c.hostel, connection_mode: c.connection_mode, bio: c.bio,
      level: Math.floor(c.xp_total / 2000) + 1, xp: c.xp_total },
    activity,
    proximity: c.proximity,
    zone: c.zone_id ? { id: c.zone_id, name: c.zone_name ?? c.zone_id } : null,
    states,
    last_seen_at: c.last_seen_at,
  };
}

const PROX_RANK: Record<string, number> = { very_close: 0, nearby: 1, on_campus: 2 };
export const proximityKey = (i: PersonItem): SortKey => [PROX_RANK[i.proximity ?? 'on_campus'] ?? 3, -Date.parse(i.last_seen_at), tiebreak(i.person.user_id)];
export const recentKey = (i: PersonItem): SortKey => [-Date.parse(i.last_seen_at), tiebreak(i.person.user_id)];

const CANDIDATE_COLUMNS = `u.id AS user_id, u.display_name, u.avatar_url, h.short_name AS hostel, u.connection_mode, u.bio, u.xp_total, u.xp_synced_at,
  p.activity_type AS live_activity, p.activity_started_at AS live_activity_started_at,
  EXISTS (SELECT 1 FROM activities a WHERE a.user_id = u.id AND a.verification_status <> 'REJECTED'
          AND a.started_at > now() - make_interval(mins => ${Math.max(1, Math.floor(config.bubble.recentlyActiveMinutes))})) AS recently_active`;

/** Live bubble members in the given cells (consent current, not banned), excluding the viewer. */
export async function bubbleCandidates(viewerId: string, viewerCell: string, q: Queryable = getPool()): Promise<Candidate[]> {
  const rows = await many<Omit<Candidate, 'proximity'> & { cell: string }>(
    `SELECT ${CANDIDATE_COLUMNS}, b.cell, b.activity_type AS declared_activity, b.zone_id, z.name AS zone_name, b.refreshed_at AS last_seen_at
     FROM bubble_members b
     JOIN users u ON u.id = b.user_id
     LEFT JOIN hostels h ON h.id = u.hostel_id
     LEFT JOIN zones z ON z.id = b.zone_id
     LEFT JOIN presence p ON p.user_id = b.user_id AND p.expires_at > now()
     WHERE b.cell = ANY($2::text[]) AND b.expires_at > now() AND b.user_id <> $1 AND NOT u.is_banned AND ${OPEN_NOW_SQL('u')}
     ORDER BY b.refreshed_at DESC LIMIT 500`,
    [viewerId, neighbourhood(viewerCell)], q,
  );
  const { syncBatchXp } = await import('../run/index.js');
  await syncBatchXp(rows, q);
  return rows.map(({ cell, ...r }) => ({ ...r, proximity: cellProximity(viewerCell, cell) }));
}

export type BubbleView = { me: MemberRow | null; viewer: Viewer; items: PersonItem[]; hidden_reason: null | 'open_to_meet_off' | 'not_in_bubble' | 'blocks_unreachable' };

/** Everyone the viewer may see in their bubble, block-filtered (fail closed). */
export async function bubbleView(viewerId: string): Promise<BubbleView> {
  const empty: Viewer = { zone_id: null, activity: null, inNeighbourhood: false };
  if (!(await openNow(viewerId))) return { me: null, viewer: empty, items: [], hidden_reason: 'open_to_meet_off' };
  const me = await liveMembership(viewerId);
  if (!me) return { me: null, viewer: empty, items: [], hidden_reason: 'not_in_bubble' };
  const viewer: Viewer = { zone_id: me.zone_id, activity: await myActivity(viewerId, me.activity_type), inNeighbourhood: true };
  let blocks: Set<string>;
  try { blocks = await getFullBlockSet(viewerId); } catch (err: any) {
    if (err?.code === 'blocks_unreachable') return { me, viewer, items: [], hidden_reason: 'blocks_unreachable' };
    throw err;
  }
  const candidates = await bubbleCandidates(viewerId, me.cell);
  return { me, viewer, items: candidates.filter((c) => !blocks.has(c.user_id)).map((c) => toItem(c, viewer)), hidden_reason: null };
}

export function countsOf(items: PersonItem[]) {
  return {
    nearby: items.filter((i) => i.states.includes('nearby')).length,
    active_nearby: items.filter((i) => i.states.includes('active_nearby')).length,
    same_zone: items.filter((i) => i.states.includes('same_zone')).length,
    same_activity: items.filter((i) => i.states.includes('same_activity')).length,
  };
}

/** GET /v1/bubble: the caller's own state only. */
export async function myBubbleState(userId: string) {
  const v = await bubbleView(userId);
  return {
    in_bubble: !!v.me,
    zone: v.me?.zone_id ? { id: v.me.zone_id, name: v.me.zone_name ?? v.me.zone_id } : null,
    expires_at: v.me?.expires_at ?? null,
    activity_type: v.me?.activity_type ?? null,
    counts: countsOf(v.items),
    hidden_reason: v.hidden_reason === 'not_in_bubble' ? null : v.hidden_reason,
    as_of: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Realtime: bubble.* to current neighbours, throttled per (member, recipient)
// ---------------------------------------------------------------------------------------------

const lastSent = new Map<string, number>();
export function resetBubbleThrottle() { lastSent.clear(); notified.clear(); }

function allow(memberId: string, recipientId: string): boolean {
  const k = `${memberId}\0${recipientId}`;
  const now = Date.now();
  const prev = lastSent.get(k);
  if (prev !== undefined && now - prev < config.bubble.eventThrottleS * 1000) return false;
  lastSent.set(k, now);
  return true;
}

function pruneThrottle() {
  const cutoff = Date.now() - config.bubble.eventThrottleS * 1000;
  for (const [k, at] of lastSent) if (at < cutoff) lastSent.delete(k);
  const nCutoff = Date.now() - config.bubble.notifyWindowHours * 3_600_000;
  for (const [k, at] of notified) if (at < nCutoff) notified.delete(k);
}

/** Members (consent current, not banned) in the 3×3 neighbourhood of `cell`, excluding `memberId`. */
async function recipientsAround(memberId: string, cell: string): Promise<{ user_id: string; cell: string }[]> {
  return many<{ user_id: string; cell: string }>(
    `SELECT b.user_id, b.cell FROM bubble_members b JOIN users u ON u.id = b.user_id
     WHERE b.cell = ANY($2::text[]) AND b.expires_at > now() AND b.user_id <> $1 AND NOT u.is_banned AND ${OPEN_NOW_SQL('u')}`,
    [memberId, neighbourhood(cell)],
  );
}

/** The member's own card as their neighbours see it. */
async function memberCandidate(memberId: string, zone: { id: string | null; name: string | null }, declared: ActivityType | null): Promise<Omit<Candidate, 'proximity'> | null> {
  const r = await one<Omit<Candidate, 'proximity' | 'declared_activity' | 'zone_id' | 'zone_name' | 'last_seen_at'>>(
    `SELECT ${CANDIDATE_COLUMNS} FROM users u LEFT JOIN hostels h ON h.id = u.hostel_id
     LEFT JOIN presence p ON p.user_id = u.id AND p.expires_at > now() WHERE u.id = $1`, [memberId]);
  if (!r) return null;
  return { ...r, declared_activity: declared, zone_id: zone.id, zone_name: zone.name, last_seen_at: new Date().toISOString() };
}

const STATE_OF: Record<BubbleEventType, string> = {
  'bubble.user_joined': 'joined', 'bubble.user_left': 'left', 'bubble.activity_started': 'activity_started', 'bubble.activity_ended': 'activity_ended',
};

/**
 * Publish one bubble event about `memberId` to each neighbour of `cell` (optionally only those `where` keeps),
 * skipping anyone blocked either way. Fails closed: no blocks answer → no events. Never throws.
 */
export async function emitBubbleEvent(type: BubbleEventType, memberId: string, member: { cell: string; zone_id: string | null; zone_name: string | null; activity_type: ActivityType | null },
  where: (recipient: { user_id: string; cell: string }) => boolean = () => true): Promise<string[]> {
  try {
    const recipients = (await recipientsAround(memberId, member.cell)).filter(where);
    if (!recipients.length) return [];
    const blocks = await getFullBlockSet(memberId);
    const card = await memberCandidate(memberId, { id: member.zone_id, name: member.zone_name }, member.activity_type);
    if (!card) return [];
    const sent: string[] = [];
    for (const r of recipients) {
      if (blocks.has(r.user_id) || !allow(memberId, r.user_id)) continue;
      const item = toItem({ ...card, proximity: cellProximity(r.cell, member.cell) }, { zone_id: null, activity: null, inNeighbourhood: false });
      publish({ type, user_ids: [r.user_id], data: { person: item.person, activity: item.activity, proximity: item.proximity, zone: item.zone, state: STATE_OF[type], at: new Date().toISOString() } });
      sent.push(r.user_id);
    }
    return sent;
  } catch (err) {
    log.warn({ err: (err as Error).message, type }, 'bubble event not sent');
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Join / leave / activity changes / sweep
// ---------------------------------------------------------------------------------------------

const notified = new Map<string, number>();

async function maybeNotify(userId: string, visibleOthers: number, zoneId: string | null) {
  if (visibleOthers < config.bubble.notifyMinOthers) return;
  const windowMs = config.bubble.notifyWindowHours * 3_600_000;
  const last = notified.get(userId);
  if (last !== undefined && Date.now() - last < windowMs) return;
  notified.set(userId, Date.now());
  const window = String(Math.floor(Date.now() / windowMs));
  await notify(userId, 'bubble.activity', 'Your bubble is busy', 'People near you are open to meet right now.',
    { ...(zoneId ? { zone_id: zoneId } : {}), route: '/bubble' }, null, campusNotificationDedupeKey('bubble.activity', window, userId));
}

export type JoinInput = { lat: number; lng: number; activity_type?: ActivityType | null };

export async function joinBubble(userId: string, input: JoinInput): Promise<MemberRow> {
  const cell = cellFor(input.lat, input.lng).key;
  const zone = await zoneAt(input.lat, input.lng);
  // From here on only `cell` and `zone` are used; the coordinates go no further.
  const { prev, row } = await withTransaction(async (tx) => {
    const prev = await one<{ cell: string; zone_id: string | null; zone_name: string | null; activity_type: ActivityType | null; live: boolean }>(
      `SELECT b.cell, b.zone_id, z.name AS zone_name, b.activity_type, b.expires_at > now() AS live
       FROM bubble_members b LEFT JOIN zones z ON z.id = b.zone_id WHERE b.user_id = $1 FOR UPDATE OF b`, [userId], tx);
    await query(
      `INSERT INTO bubble_members (user_id, cell, zone_id, activity_type, joined_at, refreshed_at, expires_at)
       VALUES ($1, $2, $3, $4, now(), now(), now() + make_interval(mins => $6::int))
       ON CONFLICT (user_id) DO UPDATE SET
         cell = EXCLUDED.cell, zone_id = EXCLUDED.zone_id,
         activity_type = CASE WHEN $5::boolean OR bubble_members.expires_at <= now() THEN EXCLUDED.activity_type ELSE bubble_members.activity_type END,
         joined_at = CASE WHEN bubble_members.expires_at > now() THEN bubble_members.joined_at ELSE now() END,
         refreshed_at = now(), expires_at = EXCLUDED.expires_at`,
      [userId, cell, zone?.id ?? null, input.activity_type ?? null, input.activity_type !== undefined, config.bubble.ttlMinutes], tx);
    return { prev, row: (await liveMembership(userId, tx))! };
  });

  const isNew = !prev || !prev.live;
  if (isNew) {
    await emitBubbleEvent('bubble.user_joined', userId, row);
  } else {
    if (prev.cell !== row.cell) {
      const oldHood = new Set(neighbourhood(prev.cell)), newHood = new Set(neighbourhood(row.cell));
      await emitBubbleEvent('bubble.user_left', userId, { ...prev }, (r) => !newHood.has(r.cell));
      await emitBubbleEvent('bubble.user_joined', userId, row, (r) => !oldHood.has(r.cell));
    }
    if ((prev.activity_type ?? null) !== (row.activity_type ?? null)) {
      await emitBubbleEvent(row.activity_type ? 'bubble.activity_started' : 'bubble.activity_ended', userId, row);
    }
  }
  if (isNew) {
    try {
      const view = await bubbleView(userId);
      if (!view.hidden_reason) await maybeNotify(userId, view.items.length, row.zone_id);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'bubble notification skipped');
    }
  }
  return row;
}

export async function leaveBubble(userId: string): Promise<boolean> {
  const gone = await one<{ cell: string; zone_id: string | null; zone_name: string | null; activity_type: ActivityType | null; live: boolean }>(
    `DELETE FROM bubble_members b WHERE b.user_id = $1
     RETURNING b.cell, b.zone_id, (SELECT name FROM zones WHERE id = b.zone_id) AS zone_name, b.activity_type, b.expires_at > now() AS live`, [userId]);
  if (gone?.live) await emitBubbleEvent('bubble.user_left', userId, gone);
  return !!gone;
}

/** Called when a recorded activity starts or ends for the user (presence activity). */
export async function onPresenceActivityChanged(userId: string, started: boolean) {
  try {
    const me = await liveMembership(userId);
    if (!me) return;
    // A type declared on the bubble already makes the member active: a recorded activity changes nothing.
    if (me.activity_type) return;
    if (started && !(await one(`SELECT 1 FROM presence WHERE user_id = $1 AND expires_at > now() AND activity_type IS NOT NULL`, [userId]))) return;
    await emitBubbleEvent(started ? 'bubble.activity_started' : 'bubble.activity_ended', userId, me);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'bubble activity hook failed');
  }
}

/** Delete expired members and members whose Open to Meet lapsed; tell their neighbours. */
export async function sweepBubble(): Promise<number> {
  const gone = await many<{ user_id: string; cell: string; zone_id: string | null; zone_name: string | null; activity_type: ActivityType | null }>(
    `DELETE FROM bubble_members b
     WHERE b.expires_at <= now()
        OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = b.user_id AND NOT u.is_banned AND ${OPEN_NOW_SQL('u')})
     RETURNING b.user_id, b.cell, b.zone_id, (SELECT name FROM zones WHERE id = b.zone_id) AS zone_name, b.activity_type`);
  for (const g of gone) await emitBubbleEvent('bubble.user_left', g.user_id, g);
  pruneThrottle();
  return gone.length;
}
