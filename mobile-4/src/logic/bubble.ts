/**
 * Your bubble (campus-service /v1/bubble + bubble.* realtime): state words, keeping the nearby list
 * current from realtime events, when to re-join, and what a join attempt came to. The server decides
 * who's in your bubble and how close (a ~250 m cell bucket); nothing here sees or computes a position
 * of anyone else. Pure, so it's unit-tested.
 */
import type { ActivityType, PersonCard, PersonState } from '@/api/featureContracts';
import type { BubbleEvent } from '@/api/campus/types';

export const STATE_LABEL: Record<PersonState, string> = {
  nearby: 'Nearby',
  active_nearby: 'Active nearby',
  recently_active: 'Recently active',
  same_zone: 'Same zone',
  same_campus: 'On campus',
  same_activity: 'Same activity',
};
/** The nearby list's state filters (`same_campus` is everyone, so it isn't one). */
export const STATE_FILTERS: PersonState[] = ['nearby', 'active_nearby', 'same_zone', 'same_activity', 'recently_active'];

export type BubbleActivity = ActivityType | 'none';
export const BUBBLE_ACTIVITIES: BubbleActivity[] = ['none', 'run', 'walk', 'workout'];
export const BUBBLE_ACTIVITY_LABEL: Record<BubbleActivity, string> = { none: 'Just around', run: 'Run', walk: 'Walk', workout: 'Workout' };
export const activityForJoin = (a: BubbleActivity): ActivityType | null => (a === 'none' ? null : a);

/** What you are in your bubble: your zone and activity (from GET /v1/bubble), for working out states. */
export type Viewer = { zone_id: string | null; activity: ActivityType | null };

const PROX_RANK: Record<string, number> = { very_close: 0, nearby: 1, on_campus: 2 };
const seenAt = (c: PersonCard) => Date.parse(c.last_seen_at ?? '') || 0;
/** The server's order: same cell first, then most recently refreshed, then id. */
export const byProximity = (a: PersonCard, b: PersonCard) =>
  (PROX_RANK[a.proximity ?? 'on_campus'] ?? 3) - (PROX_RANK[b.proximity ?? 'on_campus'] ?? 3) || seenAt(b) - seenAt(a) || (a.person.user_id < b.person.user_id ? -1 : a.person.user_id > b.person.user_id ? 1 : 0);

/**
 * States for a card built from an event. The event's card is sent without states (the server doesn't
 * know the recipient's zone or activity), so they're derived as the server would for a neighbour.
 * `recently_active` can't be known from an event: it's kept from the card already shown, if any.
 */
export function statesFor(c: Pick<PersonCard, 'activity' | 'proximity' | 'zone'>, viewer: Viewer, prev?: PersonCard): PersonState[] {
  const states: PersonState[] = [];
  const near = c.proximity === 'very_close' || c.proximity === 'nearby';
  if (near) states.push('nearby');
  if (near && c.activity) states.push('active_nearby');
  if (!c.activity && prev?.states.includes('recently_active')) states.push('recently_active');
  if (viewer.zone_id && c.zone?.id === viewer.zone_id) states.push('same_zone');
  states.push('same_campus');
  if (viewer.activity && c.activity?.type === viewer.activity) states.push('same_activity');
  return states;
}

/**
 * The nearby list after one bubble.* event: `left` removes the person; the others add or update
 * their card. With a state filter on, a card that no longer matches leaves the list. Kept in the
 * server's order.
 */
export function applyBubbleEvent(items: PersonCard[], e: BubbleEvent, viewer: Viewer, filter: PersonState | null = null): PersonCard[] {
  const id = e.person?.user_id;
  if (!id) return items;
  const rest = items.filter((c) => c.person.user_id !== id);
  if (e.state === 'left') return rest.length === items.length ? items : rest;
  const prev = items.find((c) => c.person.user_id === id);
  const activity = e.state === 'activity_ended' ? null : e.activity ?? null;
  const card: PersonCard = {
    person: e.person,
    activity,
    proximity: e.proximity ?? prev?.proximity ?? null,
    zone: e.zone ?? null,
    states: [],
    last_seen_at: e.at,
  };
  card.states = statesFor(card, viewer, prev);
  if (filter && !card.states.includes(filter)) return rest.length === items.length ? items : rest;
  return [...rest, card].sort(byProximity);
}

/** Re-join every 5 minutes while the screen is open (membership lasts 15). */
export const REJOIN_MS = 5 * 60_000;
export const BUBBLE_TTL_MS = 15 * 60_000;
const MIN_WAIT_MS = 5_000;
/** After a failed re-join: the server's Retry-After on 429, else a minute. */
export const RETRY_MS = 60_000;

/**
 * How long until the next re-join. From your last join when this screen made it; otherwise from the
 * join implied by `expires_at` (TTL before it). Never past a minute before expiry, never a tight loop.
 */
export function rejoinDelay({ lastJoinedAt, expiresAt, now, retryAfterMs }: { lastJoinedAt: number | null; expiresAt: string | null; now: number; retryAfterMs?: number | null }): number {
  if (retryAfterMs != null) return Math.max(MIN_WAIT_MS, retryAfterMs);
  const exp = expiresAt ? Date.parse(expiresAt) : NaN;
  const joined = lastJoinedAt ?? (Number.isFinite(exp) ? exp - BUBBLE_TTL_MS : null);
  let at = joined == null ? now : joined + REJOIN_MS;
  if (Number.isFinite(exp)) at = Math.min(at, exp - 60_000);
  return Math.max(MIN_WAIT_MS, at - now);
}

export type JoinOutcome =
  | { kind: 'joined' }
  | { kind: 'off_campus' }
  | { kind: 'open_to_meet_required' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'error' };

/** A join's answer: the 200 body, or the failure's status / code / Retry-After. */
export function joinOutcome(r: { ok: true; accepted: boolean; reason: string | null } | { ok: false; status: number; code: string | null; retryAfterMs?: number | null }): JoinOutcome {
  if (r.ok) return r.accepted ? { kind: 'joined' } : r.reason === 'off_campus' ? { kind: 'off_campus' } : { kind: 'error' };
  if (r.status === 409 && r.code === 'open_to_meet_required') return { kind: 'open_to_meet_required' };
  if (r.status === 429) return { kind: 'rate_limited', retryAfterMs: Math.max(MIN_WAIT_MS, r.retryAfterMs ?? RETRY_MS) };
  return { kind: 'error' };
}

export const OUTCOME_TEXT: Record<Exclude<JoinOutcome['kind'], 'joined' | 'error'>, string> = {
  off_campus: 'You’re off campus, so you’ve left your bubble. It works only on campus.',
  open_to_meet_required: 'Turn on Open to Meet to join your bubble — it only shows you to people who are open to meet too.',
  rate_limited: 'Too many tries in a minute. Wait a moment and try again.',
};

/** "Expires in 12m" — when the membership lapses unless refreshed. */
export function expiresIn(expiresAt: string | null, now = Date.now()): string | null {
  const exp = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(exp)) return null;
  const mins = Math.max(0, Math.round((exp - now) / 60_000));
  return mins < 1 ? 'Expires in under a minute' : `Expires in ${mins}m`;
}
