/**
 * XP stats, history and the XP board — the Run Module (EXPO_PUBLIC_API_URL, as GET /v1/xp in
 * api/progress.ts). The server derives every XP number; the app only reads them (ADR-033).
 *
 *   GET /v1/xp/stats                                   total, level, level_progress, today/week/month, by_source
 *   GET /v1/xp/history?limit=&cursor=                  { items[], next_cursor }, newest first; a reversed
 *                                                      award is listed with reversed: true and counts 0
 *   GET /v1/leaderboard/xp?window=daily|weekly|monthly&limit=   { window, day, entries[{rank, user_id, xp}], me, total_ranked }
 * Errors are `{ error }` (400) or Fastify's 404 for a route not deployed yet (featureUnavailable).
 *
 * Gated by the 'xpStats' capability (api/availability.ts): until it's on, every call rejects with
 * EndpointUnavailableError and the screens say "not live yet". No local stand-in.
 */
import { EndpointUnavailableError, isEndpointAvailable } from '@/api/availability';
import { api } from '@/api/client';
import { API_CONFIGURED, API_URL } from '@/api/config';
import type { XpHistoryPage, XpLeaderboard, XpLeaderboardWindow, XpStats } from '@/api/featureContracts';

/** Needs the capability switched on AND the Run Module configured. */
export const xpStatsLive = () => isEndpointAvailable('xpStats') && API_CONFIGURED;

const get = <R,>(path: string): Promise<R> => (xpStatsLive() ? api<R>(path, { base: API_URL }) : Promise.reject(new EndpointUnavailableError('xpStats')));

/** Rows per history page (the server allows 1–100). */
export const XP_HISTORY_PAGE = 30;

export const xpApi = {
  stats: () => get<XpStats>('/v1/xp/stats'),
  history: (cursor?: string | null) => get<XpHistoryPage>(`/v1/xp/history?limit=${XP_HISTORY_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  leaderboard: (window: XpLeaderboardWindow, limit = 50) => get<XpLeaderboard>(`/v1/leaderboard/xp?window=${window}&limit=${limit}`),
};
