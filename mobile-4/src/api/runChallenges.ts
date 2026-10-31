/**
 * Goals: the Run Module's challenges (EXPO_PUBLIC_API_URL).
 *
 *   GET  /v1/challenges/mine           yours and your invites, with progress, status and results
 *   POST /v1/challenges/{id}/accept    answer an invite
 *   POST /v1/challenges/{id}/decline
 * Errors are `{ error }`. Duels are Social's and territory battles campus-service's (not here).
 */
import { api, ApiError } from '@/api/client';
import { API_CONFIGURED } from '@/api/config';
import type { RunChallengeRow } from '@/logic/challenges';

const path = (id: string, action: 'accept' | 'decline') => `/v1/challenges/${encodeURIComponent(id)}/${action}`;

export const runChallengesApi = {
  mine: () => api<RunChallengeRow[]>('/v1/challenges/mine'),
  accept: (id: string) => api<{ ok: true }>(path(id, 'accept'), { method: 'POST' }),
  decline: (id: string) => api<{ ok: true }>(path(id, 'decline'), { method: 'POST' }),
};

/** The Run Module is configured and we're signed in. */
export const runChallengesLive = (mode: string) => API_CONFIGURED && mode === 'live';

/** What to say when accepting or declining fails. */
export function challengeErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return "You're offline. Try again when you're connected.";
    if (e.status === 401) return 'Sign in again to answer invites.';
    if (e.status === 403) return "This invite isn't yours to answer.";
  }
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.';
}
