/**
 * Notification settings and the newer notification kinds — pure, unit-tested
 * (notificationPrefs.test.mjs). Social owns the preferences (GET·PATCH /v1/notifications/preferences)
 * and decides delivery; this only orders the categories, builds the minimal PATCH, checks quiet hours
 * the way the server does (both or neither, 0–1439, start ≠ end) and picks the screen a kind opens.
 */
import type { NotificationCategory, NotificationPreferences, NotificationPreferencesPatch } from '@/api/featureContracts';

export type Channel = 'push' | 'in_app';

/** Social's categories (services/notify.py CATEGORIES), in the order the settings screen lists them. */
export const CATEGORIES: readonly NotificationCategory[] = ['xp', 'challenges', 'territory', 'buddies', 'workouts', 'meetups', 'bubble', 'crews', 'ambassador', 'social', 'system'];

export const CATEGORY_TEXT: Record<NotificationCategory, { label: string; hint: string }> = {
  xp: { label: 'XP & badges', hint: 'Level-ups and new badges' },
  challenges: { label: 'Challenges', hint: 'Duels, invites and zone challenges' },
  territory: { label: 'Territory', hint: 'Zones captured, lost or fading' },
  buddies: { label: 'Workout buddies', hint: 'Partner requests and matches' },
  workouts: { label: 'Shared workouts', hint: 'Invites and results' },
  meetups: { label: 'Meetups & events', hint: 'Invites, reminders and check-ins' },
  bubble: { label: 'Your bubble', hint: 'When people near you are open to meet' },
  crews: { label: 'Crews', hint: 'Joins and vouches' },
  ambassador: { label: 'Ambassador', hint: 'Tasks, rewards and your role' },
  social: { label: 'Social', hint: 'Follows, likes, comments and invites' },
  system: { label: 'Announcements', hint: 'From the Squirrel team' },
};

/** The server's own rule: only `system` is locked. A category the server marks immutable is too. */
export const isMutable = (p: NotificationPreferences, c: NotificationCategory) => c !== 'system' && p.categories[c]?.mutable !== false;

/** The smallest PATCH for one switch; null for a category that can't be changed. */
export function togglePatch(category: NotificationCategory, channel: Channel, value: boolean): NotificationPreferencesPatch | null {
  if (category === 'system') return null;
  return { categories: { [category]: { [channel]: value } } };
}

/** The preferences as they'll look once a switch is saved (shown straight away, rolled back on failure). */
export function applyToggle(p: NotificationPreferences, category: NotificationCategory, channel: Channel, value: boolean): NotificationPreferences {
  const current = p.categories[category] ?? { push: true, in_app: true, mutable: category !== 'system' };
  return { ...p, categories: { ...p.categories, [category]: { ...current, [channel]: value } } };
}

// ---------------------------------------------------------------------------
// Quiet hours: minutes after local midnight in the account's time zone
// ---------------------------------------------------------------------------

export type ClockTime = { hour: number; minute: number };

export const toClock = (minutes: number): ClockTime => ({ hour: Math.floor(minutes / 60) % 24, minute: minutes % 60 });
export const toMinutes = ({ hour, minute }: ClockTime) => hour * 60 + minute;

/** "10:00 PM" */
export function formatMinutes(minutes: number): string {
  const { hour, minute } = toClock(minutes);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** Why these quiet hours would be refused (the server's checks), or null when they're fine. */
export function quietHoursError(start: number | null, end: number | null): string | null {
  if (start == null && end == null) return null;
  if (start == null || end == null) return 'Quiet hours need both a start and an end.';
  const ok = (m: number) => Number.isInteger(m) && m >= 0 && m <= 1439;
  if (!ok(start) || !ok(end)) return 'Pick a time between 12:00 AM and 11:59 PM.';
  if (start === end) return 'Quiet hours can’t start and end at the same minute.';
  return null;
}

/** Quiet hours are always sent together: both set, or both null to turn them off. */
export function quietHoursPatch(start: number | null, end: number | null): NotificationPreferencesPatch | null {
  if (quietHoursError(start, end)) return null;
  return { quiet_hours_start: start, quiet_hours_end: end };
}

/** "10:00 PM – 7:00 AM" (overnight when the end is earlier than the start), or null when off. */
export function quietHoursText(start: number | null, end: number | null): string | null {
  if (start == null || end == null) return null;
  return `${formatMinutes(start)} – ${formatMinutes(end)}${end < start ? ' (overnight)' : ''}`;
}

// ---------------------------------------------------------------------------
// Where a tap opens, for the kinds this build adds
// ---------------------------------------------------------------------------

/** Exercise's invite codes and session ids, as Social checks them before building a path. */
const PATH_SAFE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The screen a notification kind opens: a path, null for none (shown only), or undefined when the
 * kind isn't one of these and the server's `data.route` (or the screen's own fallbacks) decides.
 * Social sends `data.route` for every kind, but some point where this app has no screen (the
 * bubble's `/explore`, the ambassador's `/ambassador/tasks`, a bare `/workout`), so these win.
 */
export function kindRoute(kind: string, data: Record<string, unknown> | null | undefined): string | null | undefined {
  const d = data ?? {};
  const safe = (v: unknown) => (typeof v === 'string' && PATH_SAFE.test(v) ? v : null);
  switch (kind) {
    case 'xp.level_up':
      return '/progress';
    case 'shared_workout.invited': {
      const code = safe(d.code);
      const session = safe(d.session_id);
      return code ? `/workout/join/${code}` : session ? `/workout/${session}` : null;
    }
    case 'shared_workout.finished': {
      const session = safe(d.session_id);
      return session ? `/workout/${session}` : null;
    }
    case 'bubble.activity':
      return '/bubble';
    case 'ambassador.task':
    case 'ambassador.reward':
    case 'ambassador.suspended':
      return '/ambassador';
    case 'system.announcement': {
      // An admin may point an announcement at a screen; the default (`/notifications`) is this list.
      const route = d.route;
      return typeof route === 'string' && route.startsWith('/') && !route.startsWith('//') && route !== '/notifications' ? route : null;
    }
    default:
      return undefined;
  }
}
