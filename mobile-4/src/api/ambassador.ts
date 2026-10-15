/**
 * The ambassador programme on the Social service (social-backend/app/routers/ambassador.py). The
 * application form stays on campusApi.ambassador / applyAmbassador (api/campus/community.ts).
 *
 *   GET  /v1/ambassador/me                          my status, referral code + invite link, counts
 *                                                    (404 not_ambassador: not an ambassador — show the application)
 *   GET  /v1/ambassador/referrals?cursor=&limit=    people who joined with my code (names/avatars only)
 *   GET  /v1/ambassador/tasks                       open tasks and my submission for each
 *   POST /v1/ambassador/tasks/{id}/submit {evidence}   once per task (409 already_submitted,
 *                                                    403 while suspended, 429 rate_limited)
 *   GET  /v1/ambassador/leaderboard?limit=          active ambassadors by activated referrals, then task XP
 *
 * XP rewards are granted by the server (through the Run Module); the app only shows them.
 * Gated by the 'ambassadorProgramme' capability and a configured Social service, like
 * api/notificationPrefs.ts.
 */
import { EndpointUnavailableError, isEndpointAvailable } from '@/api/availability';
import { ApiError, api } from '@/api/client';
import { SOCIAL_API_CONFIGURED, SOCIAL_API_URL } from '@/api/config';
import { withRetry } from '@/api/endpoints';
import type { UserSummary } from '@/api/community';
import type { AmbassadorMe, AmbassadorReferralPage } from '@/api/featureContracts';

export type { AmbassadorMe, AmbassadorReferralPage };
export type AmbassadorReferral = AmbassadorReferralPage['items'][number];

export type AmbassadorSubmission = { id: string; status: 'submitted' | 'approved' | 'rejected'; submitted_at: string; reviewed_at: string | null };
export type AmbassadorTask = {
  id: string;
  title: string;
  description: string;
  xp_reward: number;
  starts_at: string;
  ends_at: string | null;
  active: boolean;
  submission: AmbassadorSubmission | null;
};
export type AmbassadorLeaderboardEntry = { rank: number; user: UserSummary; activated_referrals: number; task_xp: number; is_me: boolean };

export const ambassadorProgrammeLive = () => isEndpointAvailable('ambassadorProgramme') && SOCIAL_API_CONFIGURED;

const call = <R,>(path: string, body?: unknown): Promise<R> =>
  ambassadorProgrammeLive()
    ? api<R>(path, { base: SOCIAL_API_URL, method: body !== undefined ? 'POST' : 'GET', body })
    : Promise.reject(new EndpointUnavailableError('ambassadorProgramme'));
const id = encodeURIComponent;
const qs = (params: Record<string, string | number | null | undefined>) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

export const ambassadorApi = {
  me: () => withRetry(() => call<AmbassadorMe>('/v1/ambassador/me')),
  referrals: (cursor?: string | null, limit = 20) => withRetry(() => call<AmbassadorReferralPage>(`/v1/ambassador/referrals${qs({ cursor, limit })}`)),
  tasks: () => withRetry(() => call<{ items: AmbassadorTask[] }>('/v1/ambassador/tasks')),
  /** Not retried: one submission per task, and a 409 already_submitted says it landed. */
  submit: (taskId: string, evidence: string) => call<AmbassadorSubmission>(`/v1/ambassador/tasks/${id(taskId)}/submit`, { evidence: evidence.trim() }),
  leaderboard: (limit = 10) => withRetry(() => call<{ entries: AmbassadorLeaderboardEntry[] }>(`/v1/ambassador/leaderboard${qs({ limit })}`)),
};

/** GET /v1/ambassador/me's "you're not an ambassador (yet)" — the application view, not an error. */
export const isNotAmbassador = (e: unknown) => e instanceof ApiError && e.status === 404 && (e.body as { code?: unknown } | undefined)?.code === 'not_ambassador';

/** What a failed task submission means, in words; null when the generic error text fits. */
export function submitErrorText(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const code = (e.body as { code?: unknown } | undefined)?.code;
  if (e.status === 409 && code === 'already_submitted') return 'You’ve already submitted this task.';
  if (e.status === 403) return 'Your ambassador role is paused, so tasks can’t be submitted right now.';
  if (e.status === 429) return 'Slow down a little and try again shortly.';
  if (e.status === 404 && code === 'not_found') return 'This task has closed.';
  return null;
}
