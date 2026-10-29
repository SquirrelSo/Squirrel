import { describe, it, expect } from 'vitest';
import { computeActions, evaluateQualification } from '../../src/territory/rules.js';

const now = new Date('2026-01-10T10:00:00Z');
const inHours = (h: number) => new Date(now.getTime() + h * 3600_000).toISOString();
const base = {
  now, userId: 'me', zone: { id: 'cc1', name: 'CC1', is_active: true },
  territory: { owner_id: null as string | null, crew_id: null as string | null, shield_until: null as string | null, last_defended_at: null as string | null, under_challenge: false },
  qualification: { id: 'q1', expires_at: inHours(20) } as { id: string; expires_at: string } | null,
  pendingVerification: false, isCrewMember: false, lastTerritoryActionAt: null as string | null,
};

describe('territory rules', () => {
  it('unclaimed + qualified → claim allowed, steal/defend not', () => {
    const a = computeActions(base);
    expect(a.claim.allowed).toBe(true);
    expect(a.steal.code).toBe('unclaimed');
    expect(a.defend.code).toBe('not_owner');
  });
  it('unverified / no qualification → cannot claim', () => {
    const a = computeActions({ ...base, qualification: null });
    expect(a.claim.allowed).toBe(false);
    expect(a.claim.code).toBe('not_qualified');
  });
  it('activity still verifying → qualification_pending', () => {
    const a = computeActions({ ...base, qualification: null, pendingVerification: true });
    expect(a.claim.code).toBe('qualification_pending');
  });
  it('expired qualification → not_qualified', () => {
    const a = computeActions({ ...base, qualification: { id: 'q', expires_at: inHours(-1) } });
    expect(a.claim.code).toBe('not_qualified');
  });
  it('owned by someone else → steal allowed (no shield), claim blocked', () => {
    const a = computeActions({ ...base, territory: { ...base.territory, owner_id: 'them' } });
    expect(a.claim.code).toBe('already_owned');
    expect(a.steal.allowed).toBe(true);
  });
  it('shield blocks steal with expiry', () => {
    const a = computeActions({ ...base, territory: { ...base.territory, owner_id: 'them', shield_until: inHours(1) } });
    expect(a.steal.code).toBe('shielded');
    expect(a.steal.expires_at).toBe(inHours(1));
  });
  it('own zone: defend only when under attack; steal blocked', () => {
    const calm = computeActions({ ...base, territory: { ...base.territory, owner_id: 'me' } });
    expect(calm.steal.code).toBe('own_zone');
    expect(calm.defend.code).toBe('not_under_attack');
    const attacked = computeActions({ ...base, territory: { ...base.territory, owner_id: 'me', under_challenge: true } });
    expect(attacked.defend.allowed).toBe(true);
  });
  it('defend cooldown', () => {
    const a = computeActions({ ...base, territory: { ...base.territory, owner_id: 'me', under_challenge: true, last_defended_at: inHours(-0.5) } });
    expect(a.defend.code).toBe('defend_cooldown');
  });
  it('crew member may defend a crew-held zone', () => {
    const a = computeActions({ ...base, isCrewMember: true, territory: { ...base.territory, owner_id: 'mate', crew_id: 'crew1', under_challenge: true } });
    expect(a.defend.allowed).toBe(true);
  });
  it('user cooldown blocks all actions briefly', () => {
    const a = computeActions({ ...base, lastTerritoryActionAt: new Date(now.getTime() - 10_000).toISOString(), rules: { userActionCooldownSeconds: 60 } });
    expect(a.claim.code).toBe('cooldown');
    expect(a.claim.expires_at).toBeTruthy();
  });
  it('inactive zone blocks everything', () => {
    const a = computeActions({ ...base, zone: { ...base.zone, is_active: false } });
    expect(a.claim.code).toBe('zone_inactive');
  });
});

describe('qualification evaluation', () => {
  const common = { distanceInZoneM: 200, timeInZoneS: 90, minTimeS: 30, minDistanceM: 80, verified: true };
  it('AREA zone qualifies on coverage ≥ threshold', () => {
    expect(evaluateQualification({ ...common, zoneType: 'AREA', threshold: 0.6, coverage: 0.7, routeCompletion: null }).qualified).toBe(true);
    expect(evaluateQualification({ ...common, zoneType: 'AREA', threshold: 0.6, coverage: 0.4, routeCompletion: null }).qualified).toBe(false);
  });
  it('ROUTE zone qualifies on route completion, not coverage', () => {
    const r = evaluateQualification({ ...common, zoneType: 'ROUTE', threshold: 0.8, coverage: 0.99, routeCompletion: 0.5 });
    expect(r.qualified).toBe(false);
    const ok = evaluateQualification({ ...common, zoneType: 'ROUTE', threshold: 0.8, coverage: null, routeCompletion: 0.9 });
    expect(ok.qualified).toBe(true);
    expect(ok.interaction).toBe('looped');
  });
  it('unverified activity never qualifies', () => {
    expect(evaluateQualification({ ...common, verified: false, zoneType: 'AREA', threshold: 0.6, coverage: 1, routeCompletion: null }).qualified).toBe(false);
  });
  it('barely touching the zone is passed_through and not qualified', () => {
    const r = evaluateQualification({ ...common, distanceInZoneM: 10, timeInZoneS: 5, zoneType: 'AREA', threshold: 0.6, coverage: 0.9, routeCompletion: null });
    expect(r.interaction).toBe('passed_through');
    expect(r.qualified).toBe(false);
  });
});
