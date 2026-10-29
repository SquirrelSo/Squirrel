/**
 * Notification settings and read receipts on the Social service (social-backend/app/routers/
 * notifications.py). The list itself still comes through campusApi.notifications (api/campus/poke.ts).
 *
 *   GET   /v1/notifications/preferences     per-category push / in-app, quiet hours, time zone
 *   PATCH /v1/notifications/preferences     only what's sent changes; `system` can't be muted (422 not_mutable)
 *   POST  /v1/notifications/{id}/read       mark one of mine read → { unread }
 *   POST  /v1/notifications/read-all        mark all of mine read → { unread }
 *
 * Gated by the 'notificationPrefs' capability (api/availability.ts) and a configured Social
 * service: otherwise every call rejects with EndpointUnavailableError and the screens say "not live
 * yet" (or fall back to POST /v1/notifications/read). Errors: `{ detail, code }`.
 */
import { EndpointUnavailableError, isEndpointAvailable } from '@/api/availability';
import { api } from '@/api/client';
import { SOCIAL_API_CONFIGURED, SOCIAL_API_URL } from '@/api/config';
import { withRetry } from '@/api/endpoints';
import type { NotificationPreferences, NotificationPreferencesPatch } from '@/api/featureContracts';

export const notificationPrefsLive = () => isEndpointAvailable('notificationPrefs') && SOCIAL_API_CONFIGURED;

const call = <R,>(path: string, init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {}): Promise<R> =>
  notificationPrefsLive()
    ? api<R>(path, { base: SOCIAL_API_URL, method: init.method ?? 'GET', body: init.body })
    : Promise.reject(new EndpointUnavailableError('notificationPrefs'));
const id = encodeURIComponent;

export const notificationPrefsApi = {
  get: () => withRetry(() => call<NotificationPreferences>('/v1/notifications/preferences')),
  /** Not retried: the screen rolls back and says so, and the next tap sends the current value. */
  update: (patch: NotificationPreferencesPatch) => call<NotificationPreferences>('/v1/notifications/preferences', { method: 'PATCH', body: patch }),
  /** Idempotent, so retried. */
  markRead: (notificationId: string) => withRetry(() => call<{ unread: number }>(`/v1/notifications/${id(notificationId)}/read`, { method: 'POST', body: {} })),
  markAllRead: () => withRetry(() => call<{ unread: number }>('/v1/notifications/read-all', { method: 'POST', body: {} })),
};
