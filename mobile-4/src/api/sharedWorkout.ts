/**
 * Workout with Partner — Exercise's shared workout sessions (EXPO_PUBLIC_EXERCISE_API_URL).
 * Everything that makes two phones agree (who's in, who's ready, when it starts and ends, each
 * other's reps) is the server's; this module only calls it and listens for its updates.
 *
 *   POST /api/workout-sessions                        { exercise_key, duration_s }   → Session (201)
 *   GET  /api/workout-sessions/{id}
 *   GET  /api/workout-sessions/invites/{code}         preview before joining
 *   POST /api/workout-sessions/invites/{code}/join
 *   PUT  /api/workout-sessions/{id}/ready             { ready }
 *   POST /api/workout-sessions/{id}/reps              { reps, seq }                   → { accepted, reps, seq }
 *   POST /api/workout-sessions/{id}/complete          { reps, seq }
 *   POST /api/workout-sessions/{id}/leave
 *   POST /api/workout-sessions/{id}/invite            { social_profile_id }   host, a Partner Hunt buddy
 *   POST /api/workout-sessions/{id}/cancel            host, lobby only
 *   POST /api/workout-sessions/invites/{code}/decline an invited person says no   → 204
 *   WS   /ws/workout-sessions/{id}?token=…            workout.session.updated · workout.reps.updated ·
 *                                                     workout.session.invited · workout.session.cancelled ·
 *                                                     workout.session.completed
 * Errors: { detail: { code, message } } (the message is safe to show).
 *
 * Gated by the 'sharedWorkout' capability (api/availability.ts): until it's on, every call rejects
 * with EndpointUnavailableError and the screens say "not live yet". No local stand-in. Invite,
 * cancel and decline are also gated by 'sharedWorkoutInvites'.
 */
import { EndpointUnavailableError, gateEndpoints, isEndpointAvailable } from '@/api/availability';
import { api, ApiError, getApiToken, refreshApiToken } from '@/api/client';
import { EXERCISE_API_CONFIGURED, EXERCISE_API_URL } from '@/api/config';
import { sessionSocketUrl, startSessionLink, type LinkDeps, type LinkState, type RaceDuration, type SessionUpdate, type SharedWorkoutSession } from '@/logic/sharedWorkout';

/** Needs the capability switched on AND an Exercise backend configured. */
export const sharedWorkoutLive = () => isEndpointAvailable('sharedWorkout') && EXERCISE_API_CONFIGURED;

const call = <R,>(path: string, init: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {}): Promise<R> =>
  sharedWorkoutLive()
    ? api<R>(path, { base: EXERCISE_API_URL, method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), body: init.body })
    : Promise.reject(new EndpointUnavailableError('sharedWorkout'));
const id = encodeURIComponent;
const base = '/api/workout-sessions';

export const sharedWorkoutApi = gateEndpoints({
  create: (exerciseKey: string, durationS: RaceDuration) => call<SharedWorkoutSession>(base, { body: { exercise_key: exerciseKey, duration_s: durationS } }),
  get: (sessionId: string) => call<SharedWorkoutSession>(`${base}/${id(sessionId)}`),
  previewInvite: (code: string) => call<SharedWorkoutSession>(`${base}/invites/${id(code)}`),
  join: (code: string) => call<SharedWorkoutSession>(`${base}/invites/${id(code)}/join`, { body: {} }),
  setReady: (sessionId: string, ready: boolean) => call<SharedWorkoutSession>(`${base}/${id(sessionId)}/ready`, { method: 'PUT', body: { ready } }),
  reportReps: (sessionId: string, reps: number, seq: number) => call<{ accepted: boolean; reps: number; seq: number }>(`${base}/${id(sessionId)}/reps`, { body: { reps, seq } }),
  complete: (sessionId: string, reps: number, seq: number) => call<SharedWorkoutSession>(`${base}/${id(sessionId)}/complete`, { body: { reps, seq } }),
  leave: (sessionId: string) => call<SharedWorkoutSession>(`${base}/${id(sessionId)}/leave`, { body: {} }),
  invite: (sessionId: string, socialProfileId: string) => call<SharedWorkoutSession>(`${base}/${id(sessionId)}/invite`, { body: { social_profile_id: socialProfileId } }),
  cancel: (sessionId: string) => call<SharedWorkoutSession>(`${base}/${id(sessionId)}/cancel`, { body: {} }),
  declineInvite: (code: string) => call<void>(`${base}/invites/${id(code)}/decline`, { body: {} }),
}, {
  invite: { capability: 'sharedWorkoutInvites' },
  cancel: { capability: 'sharedWorkoutInvites' },
  declineInvite: { capability: 'sharedWorkoutInvites' },
});

/** Exercise's machine-readable error code (`detail.code`), e.g. already_in_session, session_full. */
export function sharedWorkoutErrorCode(e: unknown): string | null {
  const d = e instanceof ApiError ? (e.body as { detail?: { code?: unknown } } | undefined)?.detail : undefined;
  return typeof d?.code === 'string' ? d.code : null;
}
/** The session an `already_in_session` refusal points at. */
export function existingSessionId(e: unknown): string | null {
  const d = e instanceof ApiError ? (e.body as { detail?: { session_id?: unknown } } | undefined)?.detail : undefined;
  return sharedWorkoutErrorCode(e) === 'already_in_session' && typeof d?.session_id === 'string' ? d.session_id : null;
}

/** Live updates for one session: its socket, polling every 2 s while the socket is down. */
export function subscribeSession(sessionId: string, onUpdate: (u: SessionUpdate) => void, onState: (s: LinkState) => void): () => void {
  return startSessionLink(
    {
      // The platform WebSocket has the handful of members the link uses (onopen/onmessage/onclose, send, close).
      openSocket: (url) => new WebSocket(url) as unknown as ReturnType<LinkDeps['openSocket']>,
      socketUrl: (token) => sessionSocketUrl(EXERCISE_API_URL, sessionId, token),
      getToken: getApiToken,
      refreshToken: refreshApiToken,
      poll: () => sharedWorkoutApi.get(sessionId),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    },
    onUpdate,
    onState,
  );
}
