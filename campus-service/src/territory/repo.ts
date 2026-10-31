import { one, many, type Queryable, getPool } from '../db/pool.js';
import { getPeopleLite, getPersonLite, type PersonLite } from '../users/repo.js';
import { crewDisplays, crewOrPlaceholder, type CrewDisplay } from '../crews/display.js';

export type TerritoryRow = {
  zone_id: string; owner_id: string | null; owner_type: 'NONE' | 'USER' | 'CREW'; crew_id: string | null;
  status: 'UNCLAIMED' | 'CLAIMED' | 'CONTESTED'; xp: number; claim_count: number; defense_count: number;
  claimed_at: string | null; last_defended_at: string | null; shield_until: string | null; version: number; updated_at: string;
  // derived
  under_challenge: boolean; in_active_challenge: boolean;
};

/**
 * under_challenge is derived, never trusted from a stored flag: a rival holds a live qualification
 * for the zone AND the shield has lapsed. in_active_challenge: a scheduled/active challenge names it.
 */
export const TERRITORY_SELECT = `
  t.zone_id, t.owner_id, t.owner_type, t.crew_id, t.status, t.xp, t.claim_count, t.defense_count,
  t.claimed_at, t.last_defended_at, t.shield_until, t.version, t.updated_at,
  (t.owner_id IS NOT NULL AND (t.shield_until IS NULL OR t.shield_until <= now()) AND EXISTS (
     SELECT 1 FROM qualification_results q
     WHERE q.zone_id = t.zone_id AND q.status = 'QUALIFIED' AND q.expires_at > now() AND q.user_id <> t.owner_id
  )) AS under_challenge,
  EXISTS (SELECT 1 FROM challenges ch WHERE ch.zone_id = t.zone_id AND ch.status IN ('accepted','active')) AS in_active_challenge
  FROM territories t`;

export async function getTerritory(zoneId: string, q: Queryable = getPool(), lock = false) {
  return one<TerritoryRow>(`SELECT ${TERRITORY_SELECT} WHERE t.zone_id = $1 ${lock ? 'FOR UPDATE OF t' : ''}`, [zoneId], q);
}

export async function listTerritories(where = '', params: unknown[] = [], q: Queryable = getPool()) {
  return many<TerritoryRow>(`SELECT ${TERRITORY_SELECT} ${where} ORDER BY t.zone_id`, params, q);
}

export type TerritoryOut = {
  zone_id: string; owner: PersonLite | null; owner_type: 'NONE' | 'USER' | 'CREW';
  crew: { id: string; name: string; color: string | null; icon: string | null } | null;
  claimed_at: string | null; defended_count: number; claim_count: number; last_defended_at: string | null;
  under_challenge: boolean; shield_until: string | null; version: number; updated_at: string;
  status: 'neutral' | 'controlled' | 'contested' | 'under_attack';
  state: 'UNCLAIMED' | 'CLAIMED' | 'CONTESTED';
  control: number | null; xp: number;
};

/** `crew`: the owning crew as shown (from Social; see crews/display.ts). Use territoryOut / serializeTerritories to look it up. */
export function serializeTerritory(t: TerritoryRow, owner: PersonLite | null, crew: CrewDisplay | null = null): TerritoryOut {
  const owned = !!t.owner_id;
  const contested = owned && (t.under_challenge || t.in_active_challenge);
  const status: TerritoryOut['status'] = !owned ? 'neutral' : t.in_active_challenge ? 'contested' : t.under_challenge ? 'under_attack' : 'controlled';
  // control: a coarse 0..1 signal — shielded/defended territory is "firmer" than a fresh, exposed one
  const control = !owned ? null : Math.min(1, 0.5 + 0.1 * t.defense_count + (t.shield_until && Date.parse(t.shield_until) > Date.now() ? 0.2 : 0) - (t.under_challenge ? 0.25 : 0));
  return {
    zone_id: t.zone_id, owner, owner_type: t.owner_type,
    crew: t.crew_id ? crew ?? { id: t.crew_id, name: '', color: null, icon: null } : null,
    claimed_at: t.claimed_at, defended_count: t.defense_count, claim_count: t.claim_count, last_defended_at: t.last_defended_at,
    under_challenge: t.under_challenge, shield_until: t.shield_until, version: t.version, updated_at: t.updated_at,
    status, state: !owned ? 'UNCLAIMED' : contested ? 'CONTESTED' : 'CLAIMED', control: control === null ? null : Math.max(0, Math.round(control * 100) / 100), xp: t.xp,
  };
}

export async function serializeTerritories(rows: TerritoryRow[], q: Queryable = getPool()) {
  const [people, crews] = await Promise.all([getPeopleLite(rows.map((r) => r.owner_id!).filter(Boolean), q), crewDisplays(rows.map((r) => r.crew_id))]);
  return rows.map((r) => serializeTerritory(r, r.owner_id ? people.get(r.owner_id) ?? null : null, crewOrPlaceholder(r.crew_id, crews)));
}

/** One territory with its owner (when not given) and crew looked up. */
export async function territoryOut(t: TerritoryRow, owner?: PersonLite | null, q: Queryable = getPool()) {
  const [who, crews] = await Promise.all([owner === undefined ? getPersonLite(t.owner_id) : Promise.resolve(owner), crewDisplays([t.crew_id])]);
  return serializeTerritory(t, who, crewOrPlaceholder(t.crew_id, crews));
}

export type TerritoryEventRow = {
  id: string; zone_id: string; action: 'CLAIM' | 'STEAL' | 'DEFEND' | 'RELEASE' | 'DECAY';
  actor_id: string | null; previous_owner_id: string | null; new_owner_id: string | null;
  triggered_by_activity_id: string | null; qualification_id: string | null; xp_awarded: number; territory_version: number; created_at: string;
};

const EVENT_TYPE: Record<TerritoryEventRow['action'], 'claimed' | 'stolen' | 'defended' | 'released' | 'decayed'> = {
  CLAIM: 'claimed', STEAL: 'stolen', DEFEND: 'defended', RELEASE: 'released', DECAY: 'decayed',
};

export async function serializeEvents(rows: TerritoryEventRow[], q: Queryable = getPool()) {
  const people = await getPeopleLite(rows.flatMap((r) => [r.actor_id, r.previous_owner_id]).filter((x): x is string => !!x), q);
  return rows.map((r) => ({
    id: r.id, zone_id: r.zone_id, type: EVENT_TYPE[r.action], action: r.action,
    actor: r.actor_id ? people.get(r.actor_id) ?? null : null,
    previous_owner: r.previous_owner_id ? people.get(r.previous_owner_id) ?? null : null,
    new_owner_id: r.new_owner_id, triggered_by_activity_id: r.triggered_by_activity_id, xp_awarded: r.xp_awarded, at: r.created_at,
  }));
}

export async function zoneHistory(zoneId: string, limit = 20, q: Queryable = getPool()) {
  return many<TerritoryEventRow>(`SELECT * FROM territory_events WHERE zone_id = $1 ORDER BY created_at DESC LIMIT $2`, [zoneId, limit], q);
}
