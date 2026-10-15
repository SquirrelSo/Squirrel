/**
 * Partner Hunt — the rules the screens follow, from Exercise's contract. Pure, so it's unit-tested
 * without the app. Every refusal has its own code; each becomes its own state, never a generic error.
 */
import type { Option, PartnerOptions, PartnerPreferences, PartnerStatus } from '@/api/partnerHunt';

/** A key's label from `options` (falls back to the key, so a new key still reads). */
export const labelOf = (list: Option[] | undefined, key: string) => list?.find((o) => o.key === key)?.label ?? key;
export const labelsOf = (list: Option[] | undefined, keys: string[]) => keys.map((k) => labelOf(list, k));

/** What stands between you and the board (GET …/matches refusals, in the server's order). */
export type BoardBlocker =
  | { kind: 'no_profile' }
  | { kind: 'age' }
  | { kind: 'xp_unavailable' } // not yours to fix: try again later
  | { kind: 'xp_locked'; xp: number | null; minXp: number }
  | { kind: 'preferences' }
  | { kind: 'blocks_unreachable' } // board withheld: try again shortly
  | { kind: 'error'; message: string };

export function boardBlocker(code: string | null, detail: Record<string, unknown>, message: string): BoardBlocker {
  switch (code) {
    case 'user_not_found':
      return { kind: 'no_profile' };
    case 'age_restricted':
      return { kind: 'age' };
    case 'xp_unavailable':
      return { kind: 'xp_unavailable' };
    case 'xp_locked':
      return { kind: 'xp_locked', xp: typeof detail.xp === 'number' ? detail.xp : null, minXp: typeof detail.min_xp === 'number' ? detail.min_xp : 100 };
    case 'preferences_required':
      return { kind: 'preferences' };
    case 'blocks_unreachable':
      return { kind: 'blocks_unreachable' };
    default:
      return { kind: 'error', message };
  }
}

/** The same, read from the status call (which never fails for a closed gate). */
export function statusBlocker(s: PartnerStatus): BoardBlocker | null {
  if (!s.age_eligible) return { kind: 'age' };
  if (!s.unlocked) return s.xp.available ? { kind: 'xp_locked', xp: s.xp.xp, minXp: s.min_xp } : { kind: 'xp_unavailable' };
  if (!s.preferences || !s.preferences.visible) return { kind: 'preferences' };
  return null;
}

/** What a refused Connect means (POST …/requests). `requestId` points at the request to show instead. */
export type RequestOutcome = { message: string; requestId?: string; showRequests?: boolean };
export function requestOutcome(code: string | null, detail: Record<string, unknown>, message: string): RequestOutcome {
  const requestId = typeof detail.request_id === 'string' ? detail.request_id : undefined;
  switch (code) {
    case 'already_requested':
      return { message: 'You’ve already asked them. Waiting for their answer.', requestId, showRequests: true };
    case 'they_asked_you':
      return { message: 'They’ve already asked you. Answer their request.', requestId, showRequests: true };
    case 'already_connected':
      return { message: 'You’re already connected.', showRequests: true };
    case 'too_soon':
      return { message: typeof detail.retry_after === 'string' ? `You asked them recently. You can ask again from ${new Date(detail.retry_after).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.` : 'You asked them recently. Try again later.' };
    case 'daily_limit':
      return { message: 'That’s 10 requests today. Try again tomorrow.' };
    case 'too_many_pending':
      return { message: '20 of your requests are still waiting. Withdraw some, or wait for answers.', showRequests: true };
    case 'not_on_board':
      return { message: 'They’re not on your board any more.' };
    default:
      return { message };
  }
}

/** Removing a buddy (DELETE …/connections/{id}): silent both ways, then the request cooldown runs. */
export const BUDDY_COOLDOWN_DAYS = 30;
export const removeBuddyNote = (name: string) =>
  `${name} won’t be told: you just disappear from each other’s connections. Neither of you can send a new request for ${BUDDY_COOLDOWN_DAYS} days.`;

/** What a remove came to. `gone`: it's no longer a connection either way (removed now, or already). */
export function removeBuddyOutcome(code: string | null, message: string): { message: string; gone: boolean } {
  if (code === 'connection_not_found') return { message: 'That connection isn’t there any more.', gone: true };
  return { message, gone: false };
}

/** Accepting connects you; the server awards each of you buddy_connected once per pair (never again on reconnecting). */
export const BUDDY_CONNECTED_XP = 20;

/** A starting point for the form: what's saved, else sensible defaults within the server's ranges. */
export function preferencesDraft(s: PartnerStatus): PartnerPreferences {
  if (s.preferences) return { ...s.preferences, city: s.preferences.city ?? '' };
  return {
    visible: true,
    activities: [],
    mode: s.options.modes.find((m) => m.key === 'either')?.key ?? s.options.modes[0]?.key ?? 'either',
    city: '',
    preferred_times: [],
    partner_genders: [],
    partner_age_min: s.options.partner_age.min,
    partner_age_max: Math.min(s.options.partner_age.max, s.options.partner_age.min + 12),
  };
}

/** The server's 422 rules, checked before saving so the form can say what's missing. */
export function preferencesProblems(p: PartnerPreferences, o: PartnerOptions): string[] {
  const out: string[] = [];
  if (!p.activities.length) out.push('Pick at least one activity.');
  if (!p.preferred_times.length) out.push('Pick at least one time you train.');
  if (p.mode !== 'remote' && !(p.city ?? '').trim()) out.push('Add your city to meet in person.');
  const { min, max } = o.partner_age;
  if (p.partner_age_min < min || p.partner_age_max > max) out.push(`Partner ages must be between ${min} and ${max}.`);
  if (p.partner_age_min > p.partner_age_max) out.push('The youngest age can’t be above the oldest.');
  return out;
}

/** What's sent: keys only, the city trimmed (and dropped for remote, as the server would). */
export const preferencesBody = (p: PartnerPreferences): PartnerPreferences => ({ ...p, city: p.mode === 'remote' ? null : (p.city ?? '').trim() || null });

/** Toggle a key in a multi-select list. */
export const toggleKey = (keys: string[], key: string) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
