/**
 * Pure territory rules: given the server's view of the world, what may this user do?
 * No I/O here so the rules are unit-testable and identical in every code path
 * (zone detail, run→zones, and the claim/steal/defend transaction itself).
 */
import { config } from '../config.js';

export type ActionAvailability = { allowed: boolean; code: string | null; reason: string | null; expires_at: string | null };
export type ZoneActions = { claim: ActionAvailability; steal: ActionAvailability; defend: ActionAvailability };

export type RulesInput = {
  now: Date;
  userId: string;
  zone: { id: string; name: string; is_active: boolean };
  territory: { owner_id: string | null; crew_id: string | null; shield_until: string | null; last_defended_at: string | null; under_challenge: boolean };
  /** A live QUALIFIED record for (user, zone), or null. */
  qualification: { id: string; expires_at: string } | null;
  /** True when the user has an activity still in verification that touches this zone. */
  pendingVerification: boolean;
  /** Is the user a member of the crew that holds the zone (crew members may defend)? */
  isCrewMember: boolean;
  lastTerritoryActionAt: string | null;
  rules?: Partial<typeof config.rules>;
};

const ok = (expires: Date | null): ActionAvailability => ({ allowed: true, code: null, reason: null, expires_at: expires ? expires.toISOString() : null });
const no = (code: string, reason: string, expires: Date | null = null): ActionAvailability => ({ allowed: false, code, reason, expires_at: expires ? expires.toISOString() : null });

export function computeActions(i: RulesInput): ZoneActions {
  const r = { ...config.rules, ...(i.rules ?? {}) };
  const now = i.now.getTime();
  const mine = !!i.territory.owner_id && i.territory.owner_id === i.userId;
  const owned = !!i.territory.owner_id;
  const shieldUntil = i.territory.shield_until ? new Date(i.territory.shield_until) : null;
  const shielded = !!shieldUntil && shieldUntil.getTime() > now;
  const cooldownUntil = i.lastTerritoryActionAt ? new Date(Date.parse(i.lastTerritoryActionAt) + r.userActionCooldownSeconds * 1000) : null;
  const onCooldown = !!cooldownUntil && cooldownUntil.getTime() > now;
  const qualUntil = i.qualification ? new Date(i.qualification.expires_at) : null;
  const qualified = !!qualUntil && qualUntil.getTime() > now;

  const notQualified = (verb: string) =>
    i.pendingVerification
      ? no('qualification_pending', `Your activity in ${i.zone.name} is still being verified.`)
      : no('not_qualified', `${verb} ${i.zone.name} to unlock this.`);

  if (!i.zone.is_active) {
    const off = no('zone_inactive', 'This zone is not active right now.');
    return { claim: off, steal: off, defend: off };
  }

  const claim = owned
    ? no('already_owned', mine ? 'Already your territory.' : 'Someone holds it — steal it instead.')
    : !qualified ? notQualified('Run or walk through')
    : onCooldown ? no('cooldown', 'Slow down — try again in a moment.', cooldownUntil)
    : ok(qualUntil);

  const steal = !owned
    ? no('unclaimed', 'Nobody holds it — claim it instead.')
    : mine ? no('own_zone', 'This is your territory.')
    : shielded ? no('shielded', 'Freshly claimed — shielded for now.', shieldUntil)
    : !qualified ? notQualified('Log activity inside')
    : onCooldown ? no('cooldown', 'Slow down — try again in a moment.', cooldownUntil)
    : ok(qualUntil);

  const canDefend = mine || (!!i.territory.crew_id && i.isCrewMember);
  const defendCooldownUntil = i.territory.last_defended_at ? new Date(Date.parse(i.territory.last_defended_at) + r.defendCooldownMinutes * 60_000) : null;
  const defend = !owned || !canDefend
    ? no('not_owner', 'Only the owner can defend.')
    : !i.territory.under_challenge ? no('not_under_attack', 'Nobody is attacking it right now.')
    : !qualified ? notQualified('Run or walk through')
    : defendCooldownUntil && defendCooldownUntil.getTime() > now ? no('defend_cooldown', 'Defended recently — hold the line a little longer.', defendCooldownUntil)
    : onCooldown ? no('cooldown', 'Slow down — try again in a moment.', cooldownUntil)
    : ok(qualUntil);

  return { claim, steal, defend };
}

/** Which qualification metric applies and whether the numbers clear the bar. Pure. */
export function evaluateQualification(input: {
  zoneType: 'AREA' | 'ROUTE'; threshold: number; coverage: number | null; routeCompletion: number | null;
  distanceInZoneM: number; timeInZoneS: number; minTimeS: number; minDistanceM: number; verified: boolean;
}): { qualified: boolean; interaction: 'passed_through' | 'looped' | 'visited'; metric: number } {
  const metric = input.zoneType === 'ROUTE' ? input.routeCompletion ?? 0 : input.coverage ?? 0;
  const touched = input.timeInZoneS >= input.minTimeS || input.distanceInZoneM >= input.minDistanceM;
  const interaction: 'passed_through' | 'looped' | 'visited' =
    input.zoneType === 'ROUTE' && (input.routeCompletion ?? 0) >= input.threshold ? 'looped' : touched ? 'visited' : 'passed_through';
  return { qualified: input.verified && touched && metric >= input.threshold, interaction, metric };
}
