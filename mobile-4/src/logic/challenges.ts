/**
 * Goals: the Run Module's own challenges (daily and group), from GET /v1/challenges/mine.
 *
 * Progress is derived server-side from verified runs in the challenge window, and results land
 * automatically when the resolver runs: nothing is claimed or decided here. This file turns one
 * row of that list into the card the Challenges screen draws, using only fields the Run Module
 * returns (see the Goals Challenge Contract): no descriptions, capacity or eligibility rules are
 * invented. Pure, so it's unit-tested without the app.
 */

export type ChallengeKind = 'daily' | 'group';
/** Display units, converted from the Run Module's metric names. */
export type ChallengeUnit = 'km' | 'minutes' | 'runs' | 'm2' | 'territories';
export type ChallengeState = 'upcoming' | 'active' | 'ended' | 'cancelled';

export type Challenge = {
  id: string;
  kind: ChallengeKind;
  title: string;
  metric: ChallengeUnit;
  /** gte: reach the target. lte: stay at or under it. */
  comparator: 'gte' | 'lte';
  /** Your progress, in display units. */
  mine: number;
  /** The target, in display units: yours for a daily, the group's for a group challenge. */
  goal: number;
  /** Group challenges: the accepted members' combined progress and how many they are. */
  group?: { value: number; members: number };
  xp: number;
  startsAt: string;
  endsAt: string;
  state: ChallengeState;
  /** Declined challenges are never shown, so a card is either an invite or one you're in. */
  myStatus: 'invited' | 'accepted';
  /** Once resolved: whether you made it and the XP it paid. Null while it's running. */
  result: { won: boolean; xp: number } | null;
};

/** One row of GET /v1/challenges/mine as sent: the challenge's own columns arrive snake_case
 *  (`SELECT c.*`), the per-user fields camelCase. Both spellings are read for the former, as the
 *  backend's own type declares camelCase. */
export type RunChallengeRow = {
  id: string;
  type: string;
  title: string;
  metric: string;
  comparator?: string;
  threshold: number | string;
  starts_at?: string;
  startsAt?: string;
  ends_at?: string;
  endsAt?: string;
  xp_reward?: number | string;
  xpReward?: number | string;
  state: string;
  participantStatus: string;
  isWinner: boolean | null;
  xpAwarded: number | string | null;
  myProgress: number | string;
  groupProgress: number | string | null;
  groupMemberCount: number | string | null;
};

const UNITS: Record<string, { unit: ChallengeUnit; scale: number }> = {
  distance_m: { unit: 'km', scale: 1 / 1000 },
  duration_s: { unit: 'minutes', scale: 1 / 60 },
  runs_completed: { unit: 'runs', scale: 1 },
  territory_area_m2: { unit: 'm2', scale: 1 },
  territories_captured: { unit: 'territories', scale: 1 },
};

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * A Run Module row → a Goals card, or null when it isn't one: declined, an unknown metric, or a
 * head-to-head (duels are Social's, and the Run Module's head_to_head is being retired).
 */
export function goalFromRun(row: RunChallengeRow, now: number = Date.now()): Challenge | null {
  if (row.type !== 'daily' && row.type !== 'group') return null;
  if (row.participantStatus !== 'invited' && row.participantStatus !== 'accepted') return null;
  const m = UNITS[row.metric];
  if (!m) return null;
  const startsAt = row.starts_at ?? row.startsAt ?? '';
  const endsAt = row.ends_at ?? row.endsAt ?? '';
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const state: ChallengeState =
    row.state === 'cancelled' ? 'cancelled' : row.state === 'resolved' || now >= end ? 'ended' : now < start ? 'upcoming' : 'active';
  const card: Challenge = {
    id: row.id,
    kind: row.type,
    title: row.title,
    metric: m.unit,
    comparator: row.comparator === 'lte' ? 'lte' : 'gte',
    mine: num(row.myProgress) * m.scale,
    goal: num(row.threshold) * m.scale,
    xp: num(row.xp_reward ?? row.xpReward),
    startsAt,
    endsAt,
    state,
    myStatus: row.participantStatus,
    result: row.isWinner === null || row.isWinner === undefined ? null : { won: row.isWinner, xp: num(row.xpAwarded) },
  };
  if (row.type === 'group') card.group = { value: num(row.groupProgress) * m.scale, members: num(row.groupMemberCount) };
  return card;
}

/** Live first (then upcoming, then finished), each soonest-ending first. */
export function sortGoals(cards: Challenge[]): Challenge[] {
  const rank: Record<ChallengeState, number> = { active: 0, upcoming: 1, ended: 2, cancelled: 3 };
  return [...cards].sort((a, b) => rank[a.state] - rank[b.state] || Date.parse(a.endsAt) - Date.parse(b.endsAt));
}

export const fmtMetric = (v: number, m: ChallengeUnit) =>
  m === 'km'
    ? `${v.toFixed(1)} km`
    : m === 'm2'
      ? `${Math.round(v).toLocaleString('en-IN')} m²`
      : m === 'runs'
        ? `${Math.round(v)} run${Math.round(v) === 1 ? '' : 's'}`
        : m === 'territories'
          ? `${Math.round(v)} zone${Math.round(v) === 1 ? '' : 's'}`
          : `${Math.round(v)} min`;

export const fmtEnds = (min: number) => (min < 60 ? `${min}m left` : min < 1440 ? `${Math.floor(min / 60)}h ${min % 60}m left` : `${Math.floor(min / 1440)}d left`);

/** Whole minutes from now until `iso` (never negative). */
export const minutesUntil = (iso: string, now: number = Date.now()) => Math.max(0, Math.floor((Date.parse(iso) - now) / 60_000));
