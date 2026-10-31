/**
 * Territory battles on the zone and crew screens: which belong where, how they're ordered and
 * worded, and the start times offered. What a person may do is the server's `actions` list, never
 * decided here. Pure, so it's unit-tested without the app.
 */
import type { BattleListResponse, ChallengeAction, ChallengeInvite } from '@/api/campus/types';

/** Group activities aren't placed yet (closer to an event than a battle), so they're not offered. */
export const BATTLE_TYPES = new Set(['territory', 'zone_race', 'weekend_war']);
const LIVE = new Set(['pending', 'accepted', 'active']);
/** Finished battles kept under the live ones, newest first. */
const RECENT_FINISHED = 3;

const sortBattles = (list: ChallengeInvite[]) => {
  const live = list.filter((b) => LIVE.has(b.status)).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const done = list.filter((b) => !LIVE.has(b.status)).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return [...live, ...done.slice(0, RECENT_FINISHED)];
};

/** The battle list, and whether crew battles are missing from it (absent flag: nothing missing). */
export type BattleList = { invites: ChallengeInvite[]; crewBattlesUnavailable: boolean };
export const battleListFrom = (body: BattleListResponse): BattleList => ({
  invites: body.invites ?? [],
  crewBattlesUnavailable: body.crew_battles_unavailable === true,
});

/**
 * A battle as campus-service pushed it (`invite.updated`, sent to each participant with their own
 * `actions`): replaces the one with its id, or joins the list if it's new. Where it shows is still
 * battlesAtZone / battlesForCrew's call.
 */
export const applyBattleUpdate = (list: BattleList, b: ChallengeInvite): BattleList => ({
  ...list,
  invites: list.invites.some((x) => x.id === b.id) ? list.invites.map((x) => (x.id === b.id ? b : x)) : [b, ...list.invites],
});

/** Territory duels and zone races at this zone. */
export const battlesAtZone = (list: ChallengeInvite[], zoneId: string) =>
  sortBattles(list.filter((b) => BATTLE_TYPES.has(b.type) && b.zone?.id === zoneId));

/** Battles against this crew (weekend wars, and duels for a zone that target the crew). */
export const battlesForCrew = (list: ChallengeInvite[], crewId: string) =>
  sortBattles(list.filter((b) => BATTLE_TYPES.has(b.type) && b.target.type === 'crew' && b.target.crew.id === crewId));

/** Buttons in this order, whichever the server allows. */
export const ACTION_ORDER: ChallengeAction[] = ['accept', 'start', 'complete', 'schedule', 'decline', 'cancel'];
export const ACTION_LABEL: Record<ChallengeAction, string> = {
  accept: 'Accept', decline: 'Decline', cancel: 'Cancel battle', schedule: 'Change time', start: 'Start', complete: 'Finish',
};
export const orderedActions = (actions: ChallengeAction[] | undefined) => ACTION_ORDER.filter((a) => actions?.includes(a));

/** "Asha challenged you" · "Asha challenged Night Owls" · "You challenged Kabir". */
export function battleHeadline(b: ChallengeInvite): string {
  const target = b.target.type === 'crew' ? b.target.crew.name || 'a crew' : b.target.person.display_name;
  if (b.direction === 'outgoing') return `You challenged ${target}`;
  return b.target.type === 'crew' ? `${b.from.display_name} challenged ${target}` : `${b.from.display_name} challenged you`;
}

/** Start times to offer: this evening, tomorrow morning and evening, Saturday morning; at least 30 min ahead. */
export function startSlots(now: Date = new Date()): { label: string; at: Date }[] {
  const mk = (days: number, h: number, m = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const sat = new Date(now);
  sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7 || 7));
  sat.setHours(7, 0, 0, 0);
  const cands = [
    { label: 'Today · 6 PM', at: mk(0, 18) },
    { label: 'Tomorrow · 6:30 AM', at: mk(1, 6, 30) },
    { label: 'Tomorrow · 6 PM', at: mk(1, 18) },
    { label: 'Sat · 7 AM', at: sat },
  ];
  return cands.filter((c) => c.at.getTime() > now.getTime() + 30 * 60_000);
}
