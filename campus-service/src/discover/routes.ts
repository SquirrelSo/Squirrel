/**
 * Discover — read-only aggregation of campus-owned data (ADR-032: map, presence, Open to Meet,
 * territory, territory battles, zone counts). Every list is block- and consent-filtered, paginated
 * (`limit` ≤ 50, keyset `cursor`) and shaped `{ items, next_cursor, hidden_reason, as_of }`.
 *
 *   GET /v1/discover                     five of each section; a failing section degrades to [] + reason
 *   GET /v1/discover/nearby              people near you who opted in (bubble cells + presence buckets)
 *   GET /v1/discover/active              people with a live activity who opted in
 *   GET /v1/discover/challenges          territory battles visible to you (never other people's invites)
 *   GET /v1/discover/crews               crews ranked by zones held (names from Social, no members)
 *   GET /v1/discover/zones               popular | contested | unclaimed zones (k-anonymous popularity)
 *
 * Nothing here returns coordinates, distances, exact visitor counts or another person's history.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { getPool, many } from '../db/pool.js';
import { getFullBlockSet } from '../blocks/service.js';
import { lookupCrewMembershipsWithStatus, lookupCrewsWithStatus } from '../identity/index.js';
import { crewDisplays } from '../crews/display.js';
import { CursorQuery, LimitQuery, paginate, tiebreak, type SortKey } from '../lib/pagination.js';
import { bucket } from '../presence/service.js';
import { SUPPRESSION_THRESHOLD_USERS, intensityFor } from '../heatmap/routes.js';
import { CHALLENGE_SELECT, expireStale, serializeChallenges, type ChallengeRow } from '../challenges/routes.js';
import {
  OPEN_NOW_SQL, bubbleCandidates, liveMembership, openNow, proximityKey, recentKey, toItem,
  type ActivityType, type Candidate, type PersonItem, type Viewer,
} from '../bubble/service.js';

type Section<T> = { items: T[]; next_cursor: string | null; hidden_reason: string | null };
type Extra = Record<string, unknown>;
const ACTIVITY = z.enum(['run', 'walk', 'workout']);
const page = { limit: LimitQuery.default(20), cursor: CursorQuery.optional() };

function blocksDown(err: unknown): boolean {
  return (err as { code?: string })?.code === 'blocks_unreachable';
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

type MyPresence = { zone_id: string | null; activity: ActivityType | null };

async function myPresence(userId: string): Promise<MyPresence | null> {
  const rows = await many<MyPresence>(
    `SELECT (SELECT z.id FROM zones z WHERE z.is_active AND ST_Contains(z.geometry, p.geom) ORDER BY ST_Area(z.geometry), z.id LIMIT 1) AS zone_id,
            p.activity_type AS activity
     FROM presence p WHERE p.user_id = $1 AND p.expires_at > now()`, [userId]);
  return rows[0] ?? null;
}

/**
 * People with live presence who opted in (consent current). With `nearOnly`, only those within the
 * nearby radius of the viewer's own presence. The exact fixes stay in SQL: rows carry a bucket and a zone.
 */
async function presenceCandidates(viewerId: string, opts: { nearOnly: boolean; activeOnly: boolean; withProximity: boolean }): Promise<Candidate[]> {
  const rows = await many<Omit<Candidate, 'proximity'> & { distance_m: number | null }>(
    `WITH me AS (SELECT geom FROM presence WHERE user_id = $1 AND expires_at > now())
     SELECT u.id AS user_id, u.display_name, u.avatar_url, h.short_name AS hostel, u.connection_mode, u.bio, u.xp_total, u.xp_synced_at,
            p.activity_type AS live_activity, p.activity_started_at AS live_activity_started_at, NULL::text AS declared_activity,
            zp.id AS zone_id, zp.name AS zone_name, p.updated_at AS last_seen_at,
            EXISTS (SELECT 1 FROM activities a WHERE a.user_id = u.id AND a.verification_status <> 'REJECTED'
                    AND a.started_at > now() - make_interval(mins => $3::int)) AS recently_active,
            (SELECT ST_Distance(p.geom::geography, me.geom::geography) FROM me) AS distance_m
     FROM presence p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN hostels h ON h.id = u.hostel_id
     LEFT JOIN LATERAL (SELECT z.id, z.name FROM zones z WHERE z.is_active AND ST_Contains(z.geometry, p.geom) ORDER BY ST_Area(z.geometry), z.id LIMIT 1) zp ON true
     WHERE p.expires_at > now() AND u.id <> $1 AND NOT u.is_banned AND ${OPEN_NOW_SQL('u')}
       AND (NOT $4::boolean OR p.activity_type IS NOT NULL)
       AND (NOT $5::boolean OR EXISTS (SELECT 1 FROM me WHERE ST_DWithin(p.geom::geography, me.geom::geography, $2)))
     ORDER BY p.updated_at DESC LIMIT 500`,
    [viewerId, config.presence.nearbyRadiusM, Math.max(1, Math.floor(config.bubble.recentlyActiveMinutes)), opts.activeOnly, opts.nearOnly],
  );
  const { syncBatchXp } = await import('../run/index.js');
  await syncBatchXp(rows, getPool());
  return rows.map(({ distance_m, ...r }) => ({ ...r, proximity: opts.withProximity && distance_m !== null ? bucket(distance_m) : null }));
}

const PROX_RANK = { very_close: 0, nearby: 1, on_campus: 2 } as const;
const proxRank = (p: Candidate['proximity']) => (p ? PROX_RANK[p] : 3);
const closer = (a: Candidate['proximity'], b: Candidate['proximity']) => (proxRank(a) <= proxRank(b) ? a : b);

type NearbyFilters = { activity_type?: ActivityType; zone_id?: string; sort: 'proximity' | 'recent'; limit: number; cursor?: string };

async function nearbySection(userId: string, f: NearbyFilters): Promise<Section<PersonItem>> {
  if (!(await openNow(userId))) return { items: [], next_cursor: null, hidden_reason: 'open_to_meet_off' };
  const [membership, presence] = await Promise.all([liveMembership(userId), myPresence(userId)]);
  if (!membership && !presence) return { items: [], next_cursor: null, hidden_reason: 'location_unknown' };
  let blocks: Set<string>;
  try { blocks = await getFullBlockSet(userId); } catch (err) {
    if (blocksDown(err)) return { items: [], next_cursor: null, hidden_reason: 'blocks_unreachable' };
    throw err;
  }
  const merged = new Map<string, Candidate>();
  if (membership) for (const c of await bubbleCandidates(userId, membership.cell)) merged.set(c.user_id, c);
  if (presence) {
    for (const c of await presenceCandidates(userId, { nearOnly: true, activeOnly: false, withProximity: true })) {
      const prev = merged.get(c.user_id);
      merged.set(c.user_id, prev ? {
        ...prev,
        live_activity: prev.live_activity ?? c.live_activity, live_activity_started_at: prev.live_activity_started_at ?? c.live_activity_started_at,
        zone_id: prev.zone_id ?? c.zone_id, zone_name: prev.zone_name ?? c.zone_name,
        proximity: closer(prev.proximity, c.proximity),
        last_seen_at: Date.parse(c.last_seen_at) > Date.parse(prev.last_seen_at) ? c.last_seen_at : prev.last_seen_at,
      } : c);
    }
  }
  const viewer: Viewer = {
    zone_id: membership?.zone_id ?? presence?.zone_id ?? null,
    activity: presence?.activity ?? membership?.activity_type ?? null,
    inNeighbourhood: true,
  };
  let items = [...merged.values()].filter((c) => !blocks.has(c.user_id)).map((c) => toItem(c, viewer));
  if (f.activity_type) items = items.filter((i) => i.activity?.type === f.activity_type);
  if (f.zone_id) items = items.filter((i) => i.zone?.id === f.zone_id);
  return { ...paginate(items, f.sort === 'recent' ? recentKey : proximityKey, f.limit, f.cursor), hidden_reason: null };
}

type ActiveFilters = { activity_type?: ActivityType; sort: 'recent' | 'level'; limit: number; cursor?: string };

async function activeSection(userId: string, f: ActiveFilters): Promise<Section<PersonItem>> {
  let blocks: Set<string>;
  try { blocks = await getFullBlockSet(userId); } catch (err) {
    if (blocksDown(err)) return { items: [], next_cursor: null, hidden_reason: 'blocks_unreachable' };
    throw err;
  }
  const viewerOpen = await openNow(userId);
  const presence = await myPresence(userId);
  const viewer: Viewer = { zone_id: presence?.zone_id ?? null, activity: presence?.activity ?? null, inNeighbourhood: false };
  // Proximity is shown only when both people are open to meet (as on /v1/people/active).
  const rows = await presenceCandidates(userId, { nearOnly: false, activeOnly: true, withProximity: viewerOpen });
  let items = rows.filter((c) => !blocks.has(c.user_id)).map((c) => toItem(c, viewer));
  if (f.activity_type) items = items.filter((i) => i.activity?.type === f.activity_type);
  const startedMs = (i: PersonItem) => Date.parse(i.activity?.started_at ?? i.last_seen_at) || 0;
  const key = f.sort === 'level'
    ? (i: PersonItem): SortKey => [-i.person.xp, -startedMs(i), tiebreak(i.person.user_id)]
    : (i: PersonItem): SortKey => [-startedMs(i), tiebreak(i.person.user_id)];
  return { ...paginate(items, key, f.limit, f.cursor), hidden_reason: null };
}

// ---------------------------------------------------------------------------------------------
// Territory battles
// ---------------------------------------------------------------------------------------------

type ChallengeFilters = { type?: ChallengeRow['type'] | string; zone_id?: string; limit: number; cursor?: string };

async function challengesSection(userId: string, f: ChallengeFilters): Promise<Section<Extra> & { crew_battles_unavailable: boolean }> {
  let blocks: Set<string>;
  try { blocks = await getFullBlockSet(userId); } catch (err) {
    if (blocksDown(err)) return { items: [], next_cursor: null, hidden_reason: 'blocks_unreachable', crew_battles_unavailable: false };
    throw err;
  }
  await expireStale();
  const membership = await lookupCrewMembershipsWithStatus([userId]);
  const myCrews = (membership.memberships.get(userId) ?? []).map((c) => c.id);
  // Only battles the caller is part of: created, targeted at them, or at a crew they belong to.
  const rows = await many<ChallengeRow>(
    `${CHALLENGE_SELECT}
     WHERE ch.status IN ('pending','accepted','active')
       AND (ch.created_by = $1 OR ch.target_user_id = $1 OR ch.target_crew_id = ANY($2::uuid[]))
       AND ($3::text IS NULL OR ch.type = $3) AND ($4::text IS NULL OR ch.zone_id = $4)
     ORDER BY ch.starts_at, ch.id LIMIT 300`,
    [userId, myCrews, f.type ?? null, f.zone_id ?? null]);
  const visible = rows.filter((r) => ![r.created_by, r.target_user_id].some((id) => id && id !== userId && blocks.has(id)));
  const [qualified, near] = await Promise.all([
    many<{ zone_id: string }>(`SELECT DISTINCT zone_id FROM qualification_results WHERE user_id = $1 AND status = 'QUALIFIED' AND (expires_at IS NULL OR expires_at > now())`, [userId]),
    many<{ zone_id: string }>(
      `SELECT zone_id FROM bubble_members WHERE user_id = $1 AND expires_at > now() AND zone_id IS NOT NULL
       UNION
       SELECT z.id FROM zones z JOIN presence p ON p.user_id = $1 AND p.expires_at > now()
       WHERE z.is_active AND ST_DWithin(z.geometry::geography, p.geom::geography, $2)`, [userId, config.presence.nearbyM]),
  ]);
  const qualifiedSet = new Set(qualified.map((r) => r.zone_id)), nearSet = new Set(near.map((r) => r.zone_id));
  const serialized = await serializeChallenges(visible, userId);
  const items = visible.map((r, i) => ({
    ...serialized[i]!,
    relation: r.created_by === userId ? 'yours' : r.target_user_id === userId ? 'incoming' : 'crew',
    zone_qualified: !!r.zone_id && qualifiedSet.has(r.zone_id),
    near_you: !!r.zone_id && nearSet.has(r.zone_id),
  }));
  const key = (c: (typeof items)[number]): SortKey => [c.near_you ? 0 : 1, c.zone_qualified ? 0 : 1, Date.parse(String(c.starts_at)), String(c.id)];
  return { ...paginate(items, key, f.limit, f.cursor), hidden_reason: null, crew_battles_unavailable: (membership.statuses.get(userId) ?? 'unknown') === 'unknown' };
}

// ---------------------------------------------------------------------------------------------
// Crews and zones (aggregates only)
// ---------------------------------------------------------------------------------------------

async function crewsSection(f: { limit: number; cursor?: string }): Promise<Section<Extra>> {
  const held = await many<{ crew_id: string; zones_held: number }>(
    `SELECT t.crew_id::text AS crew_id, count(*)::int AS zones_held FROM territories t JOIN zones z ON z.id = t.zone_id AND z.is_active
     WHERE t.crew_id IS NOT NULL AND t.owner_type <> 'NONE' GROUP BY t.crew_id`);
  const status = await lookupCrewsWithStatus(held.map((h) => h.crew_id));
  const names = await crewDisplays(held.map((h) => h.crew_id));
  const items = held
    // A crew Social no longer knows (deleted) is dropped; during an outage the id is shown without a name.
    .filter((h) => status.unavailable || names.has(h.crew_id))
    .map((h) => ({ crew: names.get(h.crew_id) ?? { id: h.crew_id, name: '', color: null, icon: null }, zones_held: h.zones_held }));
  const result = paginate(items, (c) => [-c.zones_held, c.crew.id], f.limit, f.cursor);
  return { ...result, hidden_reason: status.unavailable && items.length ? 'crew_names_unavailable' : null };
}

type ZoneSort = 'popular' | 'contested' | 'unclaimed';
const POP_RANK = { high: 0, medium: 1, low: 2 } as const;

async function zonesSection(f: { sort: ZoneSort; limit: number; cursor?: string }): Promise<Section<Extra>> {
  const rows = await many<{ id: string; name: string; kind: string; status: string; owner_type: string; under_challenge: boolean; battle: boolean; users: number | null }>(
    `WITH pop AS (
       SELECT q.zone_id, count(DISTINCT q.user_id)::int AS users
       FROM qualification_results q
       JOIN activities a ON a.id = q.activity_id AND a.verification_status = 'VERIFIED'
       JOIN users u ON u.id = q.user_id AND NOT u.is_banned
       WHERE q.verified AND q.interaction <> 'passed_through' AND q.evaluated_at > now() - interval '7 days'
       GROUP BY q.zone_id
     )
     SELECT z.id, z.name, z.kind, coalesce(t.status, 'UNCLAIMED') AS status, coalesce(t.owner_type, 'NONE') AS owner_type,
            coalesce(t.under_challenge, false) AS under_challenge,
            EXISTS (SELECT 1 FROM challenges c WHERE c.zone_id = z.id AND c.status IN ('accepted','active')) AS battle,
            -- k-anonymity: a count below the threshold never leaves SQL
            CASE WHEN pop.users >= $1 THEN pop.users ELSE NULL END AS users
     FROM zones z LEFT JOIN territories t ON t.zone_id = z.id LEFT JOIN pop ON pop.zone_id = z.id
     WHERE z.is_active`, [SUPPRESSION_THRESHOLD_USERS]);
  const all = rows.map((r) => {
    const popularity = r.users === null ? null : intensityFor(r.users);
    return {
      zone: { id: r.id, name: r.name, kind: r.kind },
      territory: { status: r.status.toLowerCase(), owner_type: r.owner_type.toLowerCase() },
      popularity,
      contested: r.status === 'CONTESTED' || r.under_challenge || r.battle,
    };
  });
  const items = f.sort === 'popular' ? all.filter((z) => z.popularity !== null)
    : f.sort === 'contested' ? all.filter((z) => z.contested)
    : all.filter((z) => z.territory.status === 'unclaimed');
  // Ordered by bucket, then name: the cursor never carries a suppressed or exact count.
  const key = (z: (typeof all)[number]): SortKey => f.sort === 'popular'
    ? [POP_RANK[z.popularity!], z.zone.name, z.zone.id]
    : [z.popularity ? POP_RANK[z.popularity] : 3, z.zone.name, z.zone.id];
  return { ...paginate(items, key, f.limit, f.cursor), hidden_reason: null };
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export async function discoverRoutes(app: FastifyInstance) {
  const asOf = () => new Date().toISOString();

  app.get('/v1/discover', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    z.object({}).strict().parse(req.query ?? {});
    const top = { limit: 5 };
    const sections = {
      nearby: () => nearbySection(user.id, { sort: 'proximity', ...top }),
      active: () => activeSection(user.id, { sort: 'recent', ...top }),
      challenges: () => challengesSection(user.id, top),
      zones: () => zonesSection({ sort: 'popular', ...top }),
      crews: () => crewsSection(top),
    };
    const out: Record<string, unknown> = {};
    const reasons: Record<string, string | null> = {};
    await Promise.all(Object.entries(sections).map(async ([name, fn]) => {
      try {
        const s = await fn();
        out[name] = s.items;
        reasons[name] = s.hidden_reason;
      } catch (err) {
        req.log.warn({ err, section: name }, 'discover section failed');
        out[name] = [];
        reasons[name] = 'unavailable';
      }
    }));
    return { nearby: out.nearby, active: out.active, challenges: out.challenges, zones: out.zones, crews: out.crews, reasons, as_of: asOf() };
  });

  app.get('/v1/discover/nearby', { preHandler: requireAuth }, async (req) => {
    const q = z.object({ activity_type: ACTIVITY.optional(), zone_id: z.string().min(1).max(64).optional(), sort: z.enum(['proximity', 'recent']).default('proximity'), ...page }).strict().parse(req.query ?? {});
    return { ...(await nearbySection(currentUser(req).id, q)), as_of: asOf() };
  });

  app.get('/v1/discover/active', { preHandler: requireAuth }, async (req) => {
    const q = z.object({ activity_type: ACTIVITY.optional(), sort: z.enum(['recent', 'level']).default('recent'), ...page }).strict().parse(req.query ?? {});
    return { ...(await activeSection(currentUser(req).id, q)), as_of: asOf() };
  });

  app.get('/v1/discover/challenges', { preHandler: requireAuth }, async (req) => {
    const q = z.object({ type: z.enum(['territory', 'weekend_war', 'zone_race', 'group_activity']).optional(), zone_id: z.string().min(1).max(64).optional(), ...page }).strict().parse(req.query ?? {});
    return { ...(await challengesSection(currentUser(req).id, q)), as_of: asOf() };
  });

  app.get('/v1/discover/crews', { preHandler: requireAuth }, async (req) => {
    const q = z.object({ ...page }).strict().parse(req.query ?? {});
    return { ...(await crewsSection(q)), as_of: asOf() };
  });

  app.get('/v1/discover/zones', { preHandler: requireAuth }, async (req) => {
    const q = z.object({ sort: z.enum(['popular', 'contested', 'unclaimed']).default('popular'), ...page }).strict().parse(req.query ?? {});
    return { ...(await zonesSection(q)), as_of: asOf() };
  });
}
