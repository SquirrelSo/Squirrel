/** Forward campus notifications to Social, the owner of the in-app list and push delivery. */
import { createHash } from 'node:crypto';
import { publish } from '../realtime/bus.js';
import { postSocialNotification } from '../identity/index.js';

export type NotificationType =
  | 'territory.stolen' | 'territory.challenged' | 'territory.defended' | 'zone.claimed'
  | 'challenge.invitation' | 'challenge.reminder' | 'challenge.updated'
  | 'event.reminder' | 'meetup.check_in' | 'meetup.invited' | 'meetup.accepted' | 'meetup.declined' | 'meetup.cancelled'
  | 'activity.verification_complete'
  | 'bubble.activity';

export function campusNotificationDedupeKey(type: NotificationType, sourceId: string, recipientId: string, transition = ''): string {
  const digest = createHash('sha256').update(`${type}\0${sourceId}\0${recipientId}\0${transition}`).digest('hex');
  return `campus:${type}:${digest}`;
}

function routeFor(type: NotificationType, data: Record<string, unknown>): string {
  if (typeof data.route === 'string' && data.route.startsWith('/')) return data.route;
  if (typeof data.zone_id === 'string') return `/zone/${encodeURIComponent(data.zone_id)}`;
  if (typeof data.crew_id === 'string') return `/crew/${encodeURIComponent(data.crew_id)}`;
  if (typeof data.meetup_id === 'string') return `/meetup/${encodeURIComponent(data.meetup_id)}`;
  if (type.startsWith('challenge.')) {
    // Temporary until group activity challenges have their own screen; Invites contains Social duels only.
    return '/notifications';
  }
  return '/notifications';
}

function appCategory(type: NotificationType): string {
  if (type.startsWith('territory.') || type.startsWith('zone.')) return 'territory';
  if (type.startsWith('challenge.')) return 'invite';
  if (type.startsWith('meetup.') || type.startsWith('event.')) return 'event';
  if (type.startsWith('bubble.')) return 'bubble';
  return type;
}

type NotificationEvent = { userId: string; type: NotificationType; title: string; body: string | null; data: Record<string, unknown>; retry?: boolean };

function publishAccepted(result: { created: boolean; notification_id: string | null }, event: NotificationEvent) {
  if (!result.notification_id || (!result.created && !event.retry)) return;
  const text = event.body ? `${event.title} · ${event.body}` : event.title;
  publish({
    type: 'notification.created',
    user_ids: [event.userId],
    data: {
      id: result.notification_id,
      type: appCategory(event.type),
      actor: null,
      text,
      created_at: new Date().toISOString(),
      read: false,
      data: event.data,
    },
  });
}

function scheduleRetry(payload: Record<string, unknown>, event: NotificationEvent, attempt: 1 | 2) {
  const delayMs = attempt === 1 ? 1_000 : 5_000;
  const timer = setTimeout(() => {
    void (async () => {
      const result = await postSocialNotification(payload, { bypassBackoff: true });
      if (result) {
        publishAccepted(result, { ...event, retry: true });
      } else if (attempt === 1) {
        scheduleRetry(payload, event, 2);
      }
    })();
  }, delayMs);
  // This is best-effort, in-memory delivery. A retry must never keep the service alive by itself.
  timer.unref?.();
}

/** Best-effort Social delivery: a missing/down Social never rolls back the campus action. */
export async function notify(
  userId: string,
  type: NotificationType,
  title: string,
  body: string | null,
  data: Record<string, unknown>,
  actorId: string | null,
  dedupeKey: string,
) {
  const routedData = { ...data, route: routeFor(type, data) };
  const payload = {
    user_subject: userId,
    kind: type,
    ...(actorId && actorId !== userId ? { actor_subject: actorId } : {}),
    title,
    ...(body === null ? {} : { body }),
    actor_fallback: 'Someone',
    data: routedData,
    dedupe_key: dedupeKey,
  };
  const event = { userId, type, title, body, data: routedData };
  const result = await postSocialNotification(payload);

  // The initial attempt is best effort; bounded retries happen asynchronously and cannot delay
  // the caller's response. Social's dedupe key makes replay safe after ambiguous network failures.
  if (result) publishAccepted(result, event);
  else scheduleRetry(payload, event, 1);
  return result;
}
