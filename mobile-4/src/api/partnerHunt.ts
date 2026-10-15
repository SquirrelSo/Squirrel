/**
 * Partner Hunt — Exercise (EXPO_PUBLIC_EXERCISE_API_URL), every route under /api/users/{id}, where
 * {id} is the Exercise user id sign-in returns (useAuth().userId). Contract: "Partner Hunt API".
 *
 *   GET    …/partner-hunt                                   status, gates and `options` (labels)
 *   PUT    …/partner-hunt/preferences                       Preferences → Preferences
 *   GET    …/partner-hunt/matches                           { min_xp, matches: BoardCard[] }
 *   POST   …/partner-hunt/blocks          { card_id }       a Social block, everywhere
 *   GET    …/partner-hunt/requests                          { incoming, outgoing, connections }
 *   POST   …/partner-hunt/requests        { card_id }       → Request (201)
 *   POST   …/partner-hunt/requests/{id}/accept              → Connection
 *   POST   …/partner-hunt/requests/{id}/decline             → 204 (silent)
 *   DELETE …/partner-hunt/requests/{id}                     → 204 (the sender takes it back)
 *   DELETE …/partner-hunt/connections/{id}                  → 204 remove a buddy (silent; 30-day cooldown)
 *
 * Cards are anonymous until both say yes: a first name and last initial, an age band, and an opaque
 * per-viewer `card_id` (never shown, never a user id). A Connection adds `social_profile_id`.
 * Errors: { detail: { code, message, …extras } }; errorCode() (api/campus) reads the code.
 * Removing a buddy is gated by the 'buddyRemove' capability (api/availability.ts).
 */
import { gateEndpoints } from '@/api/availability';
import { api, ApiError } from '@/api/client';
import { EXERCISE_API_CONFIGURED, EXERCISE_API_URL } from '@/api/config';

export type Option = { key: string; label: string };
export type PartnerOptions = {
  activities: Option[];
  times: Option[];
  modes: Option[];
  genders: Option[];
  partner_age: { min: number; max: number };
  min_xp: number;
};
export type PartnerPreferences = {
  visible: boolean;
  activities: string[];
  mode: string;
  city: string | null;
  preferred_times: string[];
  /** [] = no preference. */
  partner_genders: string[];
  partner_age_min: number;
  partner_age_max: number;
};
export type PartnerStatus = {
  min_xp: number;
  xp: { available: boolean; xp: number | null; updated_at: string | null };
  unlocked: boolean;
  age_eligible: boolean;
  fitness_level: string | null;
  preferences: PartnerPreferences | null;
  /** Unlocked, age-eligible and visible preferences: the board will open. */
  ready: boolean;
  options: PartnerOptions;
};
export type PartnerCard = {
  /** Opaque, per viewer: send it back for Connect and Block. Never show it. */
  card_id: string;
  display_name: string;
  age_band: string;
  fitness_level: string;
  shared_activities: string[];
  shared_times: string[];
  meet: string[];
  city: string | null;
};
export type BoardCard = PartnerCard & { score: number; reasons: string[] };
export type PartnerRequest = { request_id: string; status: 'pending' | 'expired'; created_at: string; expires_at: string; person: PartnerCard };
export type PartnerConnection = { request_id: string; accepted_at: string; person: PartnerCard & { social_profile_id: string } };
export type PartnerRequests = { incoming: PartnerRequest[]; outgoing: PartnerRequest[]; connections: PartnerConnection[] };

export const PARTNER_HUNT_CONFIGURED = EXERCISE_API_CONFIGURED;

const call = <T,>(userId: string, path: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}) =>
  api<T>(`/api/users/${encodeURIComponent(userId)}/partner-hunt${path}`, { base: EXERCISE_API_URL, method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), body: init.body });
const rid = encodeURIComponent;

export const partnerHuntApi = gateEndpoints({
  status: (userId: string) => call<PartnerStatus>(userId, ''),
  savePreferences: (userId: string, prefs: PartnerPreferences) => call<PartnerPreferences>(userId, '/preferences', { method: 'PUT', body: prefs }),
  matches: (userId: string) => call<{ min_xp: number; matches: BoardCard[] }>(userId, '/matches'),
  block: (userId: string, cardId: string) => call<{ blocked_card_id: string }>(userId, '/blocks', { body: { card_id: cardId } }),
  requests: (userId: string) => call<PartnerRequests>(userId, '/requests'),
  sendRequest: (userId: string, cardId: string) => call<PartnerRequest>(userId, '/requests', { body: { card_id: cardId } }),
  accept: (userId: string, requestId: string) => call<PartnerConnection>(userId, `/requests/${rid(requestId)}/accept`, { body: {} }),
  decline: (userId: string, requestId: string) => call<void>(userId, `/requests/${rid(requestId)}/decline`, { body: {} }),
  withdraw: (userId: string, requestId: string) => call<void>(userId, `/requests/${rid(requestId)}`, { method: 'DELETE' }),
  /** `requestId` is the connection's request_id. */
  removeConnection: (userId: string, requestId: string) => call<void>(userId, `/connections/${rid(requestId)}`, { method: 'DELETE' }),
}, {
  removeConnection: { capability: 'buddyRemove' },
});

/** Extras Exercise puts beside the code: min_xp / xp (xp_locked), request_id (already_requested, they_asked_you), retry_after (too_soon). */
export function errorDetail(e: unknown): Record<string, unknown> {
  const d = e instanceof ApiError ? (e.body as { detail?: unknown } | undefined)?.detail : undefined;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}
