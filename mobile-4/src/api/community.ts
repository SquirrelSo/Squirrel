/**
 * Community routes of the Social service (social-backend/app/routers/{community,crews,events,
 * challenges,notifications}.py), plus the two live counters (Run Module GET /v1/live, Exercise
 * backend GET /api/live). Same client and errors as api/social.ts.
 *
 *   GET  /v1/me/membership · POST /v1/me/referral {code}        waitlist, referral code, founding badge
 *   GET  /v1/community/config                                   hostels, founding and referral rules
 *   GET  /v1/stats/daily?days                                   campus totals per day, and mine today
 *   GET  /v1/leaderboards/xp|hostels?window=daily|weekly        top 10 by XP · hostel vs hostel
 *   GET|POST /v1/crews · GET /v1/crews/:id · POST /v1/crews/:id/join · DELETE /v1/crews/:id/membership
 *   POST|DELETE /v1/crews/:id/members/:userId/vouch
 *   GET|POST /v1/events · GET|DELETE /v1/events/:id · POST|DELETE /v1/events/:id/rsvp
 *   POST /v1/events/:id/checkin · POST /v1/checkins              "I'm here", telling chosen friends
 *   GET|POST /v1/challenges · POST /v1/challenges/:id/accept|decline|cancel
 *   GET /v1/notifications · /unread-count · POST /v1/notifications/read
 *   POST /v1/me/push-tokens · DELETE /v1/me/push-tokens/:token
 *   GET|PUT /v1/dates/settings · GET /v1/dates/suggestions?user_id · POST /v1/dates/suggestions/:id/dismiss
 *   GET|POST|DELETE /v1/users/:id/block                        Squirrel Dates (suggestion only) and blocking
 */
import { api } from '@/api/client';
import { API_CONFIGURED, EXERCISE_API_CONFIGURED, EXERCISE_API_URL, SOCIAL_API_URL } from '@/api/config';
import { withRetry } from '@/api/endpoints';
import type { AmbassadorApplication, AmbassadorState } from '@/api/campus/types';
import type { Page, PostAuthor } from '@/api/social';

export type UserSummary = PostAuthor;
export type Interest = 'running' | 'walking' | 'cycling' | 'yoga' | 'hiit' | 'climbing' | 'nutrition' | 'other';
export type BoardWindow = 'daily' | 'weekly';

export type Membership = {
  position: number;
  effective_position: number;
  members_total: number;
  referral_code: string;
  invite_url: string | null;
  referrals: number;
  referrals_to_skip: number;
  skipped: boolean;
  admitted: boolean;
  email_verified: boolean;
  founding: { badge_id: string; title: string; rank: number } | null;
  referred_by: UserSummary | null;
};

export type CommunityConfig = { hostels: string[]; founding_first: number; founding_total: number; referrals_to_skip: number; timezone: string };

export type DayStats = { day: string; active_members: number; runs: number; km: number; workouts: number };
export type DailyStats = { timezone: string; today: DayStats; me_today: { runs: number; km: number; workouts: number }; days: DayStats[] };

export type XpBoardEntry = { rank: number; xp: number; user: UserSummary; hostel: string | null; is_me: boolean };
export type XpBoard = { window: BoardWindow; day: string; entries: XpBoardEntry[]; me: XpBoardEntry | null; available: boolean };
export type HostelEntry = { rank: number; hostel: string; xp: number; members: number; active: number; is_mine: boolean };
export type HostelBoard = { window: BoardWindow; day: string; enabled: boolean; entries: HostelEntry[]; available: boolean };

export type CrewOut = {
  id: string;
  name: string;
  tagline: string;
  interest: Interest;
  meets: string;
  scope: 'campus' | 'online';
  hostel: string | null;
  members_count: number;
  created_at: string;
  is_member: boolean;
  my_role: 'owner' | 'member' | null;
  member_since: string | null;
  preview: UserSummary[];
};
export type CrewMember = { user: UserSummary; role: 'owner' | 'member'; member_since: string; vouches: number; vouched_by_me: boolean; is_me: boolean };
export type CrewDetail = CrewOut & { members: CrewMember[]; upcoming_events: EventOut[] };
export type NewCrew = { name: string; interest: Interest; tagline?: string; meets?: string; scope?: 'campus' | 'online'; hostel?: string | null };

export type EventOut = {
  id: string;
  title: string;
  description: string;
  kind: Interest;
  venue: string;
  online: boolean;
  starts_at: string;
  ends_at: string | null;
  capacity: number | null;
  going_count: number;
  cancelled: boolean;
  crew: { id: string; name: string; interest: Interest } | null;
  host: UserSummary;
  my_rsvp: 'going' | 'interested' | null;
  checked_in: boolean;
  attendees: UserSummary[];
};
export type NewEvent = {
  title: string;
  kind: Interest;
  starts_at: string;
  description?: string;
  venue?: string;
  online?: boolean;
  ends_at?: string | null;
  capacity?: number | null;
  crew_id?: string | null;
};
export type CheckIn = { id: string; place: string; event_id: string | null; note: string; notified: number; created_at: string };

export type Challenge = {
  id: string;
  metric: 'km' | 'workouts';
  days: number;
  status: 'pending' | 'accepted' | 'declined' | 'finished' | 'cancelled';
  created_at: string;
  starts_at: string | null;
  ends_at: string | null;
  me: { user: UserSummary; score: number };
  opponent: { user: UserSummary; score: number };
  i_challenged: boolean;
  winner_id: string | null;
};

export type AppNotification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  data: { route?: string; [key: string]: unknown };
  actor: UserSummary | null;
  created_at: string;
  read: boolean;
};
export type NotificationPage = Page<AppNotification> & { unread: number };

/** Squirrel Dates: advisory only — there is no invite endpoint. */
export type DateSuggestionOut = { id: string; user: UserSummary; reason: string; zone: { id: string; name: string }; suggested_time: string | null };
export type DateSuggestionsOut = { available: boolean; enabled: boolean; reason: string | null; suggestions: DateSuggestionOut[] };
export type DatesSettings = { enabled: boolean; zones_ready: boolean };
export type BlockResult = { user_id: string; blocked: boolean };

const s = <T>(path: string, init: { method?: string; body?: unknown } = {}) => api<T>(path, { ...init, base: SOCIAL_API_URL });
const safe = <T>(path: string, init: { method?: string; body?: unknown } = {}) => withRetry(() => s<T>(path, init));
const id = encodeURIComponent;

function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const parts = Object.entries(params)
    .filter(([, v]) => v != null && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export const communityApi = {
  membership: () => safe<Membership>('/v1/me/membership'),
  claimReferral: (code: string) => s<Membership>('/v1/me/referral', { body: { code: code.trim().toUpperCase() } }),
  config: () => safe<CommunityConfig>('/v1/community/config'),
  dailyStats: (days = 7) => safe<DailyStats>(`/v1/stats/daily${qs({ days })}`),
  xpBoard: (window: BoardWindow = 'daily') => safe<XpBoard>(`/v1/leaderboards/xp${qs({ window })}`),
  hostelBoard: (window: BoardWindow = 'daily') => safe<HostelBoard>(`/v1/leaderboards/hostels${qs({ window })}`),
  /** Your latest application and whether you may apply now (Social sends the form's fields). */
  ambassador: () => safe<AmbassadorState>('/v1/ambassador/application'),
  /** Not retried: one key per form, and Social returns the existing application for a repeated key. */
  applyAmbassador: (answers: Record<string, string>, idempotencyKey: string) =>
    s<AmbassadorApplication>('/v1/ambassador/application', { body: { answers, idempotency_key: idempotencyKey } }),
};

export const crewsApi = {
  list: (opts: { mine?: boolean; q?: string; cursor?: string | null } = {}) => safe<Page<CrewOut>>(`/v1/crews${qs({ mine: opts.mine, q: opts.q, cursor: opts.cursor })}`),
  get: (crewId: string) => safe<CrewDetail>(`/v1/crews/${id(crewId)}`),
  create: (body: NewCrew) => s<CrewDetail>('/v1/crews', { body }),
  join: (crewId: string) => safe<CrewDetail>(`/v1/crews/${id(crewId)}/join`, { method: 'POST' }),
  leave: (crewId: string) => safe<void>(`/v1/crews/${id(crewId)}/membership`, { method: 'DELETE' }),
  vouch: (crewId: string, userId: string) => safe<{ vouches: number; vouched_by_me: boolean }>(`/v1/crews/${id(crewId)}/members/${id(userId)}/vouch`, { method: 'POST' }),
  unvouch: (crewId: string, userId: string) => safe<{ vouches: number; vouched_by_me: boolean }>(`/v1/crews/${id(crewId)}/members/${id(userId)}/vouch`, { method: 'DELETE' }),
};

export const eventsApi = {
  list: (scope: 'upcoming' | 'mine' | 'past' = 'upcoming', opts: { crewId?: string; cursor?: string | null } = {}) =>
    safe<Page<EventOut>>(`/v1/events${qs({ scope, crew_id: opts.crewId, cursor: opts.cursor })}`),
  get: (eventId: string) => safe<EventOut>(`/v1/events/${id(eventId)}`),
  create: (body: NewEvent) => s<EventOut>('/v1/events', { body }),
  cancel: (eventId: string) => s<void>(`/v1/events/${id(eventId)}`, { method: 'DELETE' }),
  rsvp: (eventId: string, status: 'going' | 'interested' = 'going') => safe<EventOut>(`/v1/events/${id(eventId)}/rsvp`, { method: 'POST', body: { status } }),
  unrsvp: (eventId: string) => safe<EventOut>(`/v1/events/${id(eventId)}/rsvp`, { method: 'DELETE' }),
  checkIn: (eventId: string, notifyUserIds: string[] = [], note = '') =>
    s<CheckIn>(`/v1/events/${id(eventId)}/checkin`, { body: { notify_user_ids: notifyUserIds, note } }),
  meetupCheckIn: (place: string, notifyUserIds: string[] = [], note = '') =>
    s<CheckIn>('/v1/checkins', { body: { place, notify_user_ids: notifyUserIds, note } }),
};

export const datesApi = {
  settings: () => safe<DatesSettings>('/v1/dates/settings'),
  setEnabled: (enabled: boolean) => s<DatesSettings>('/v1/dates/settings', { method: 'PUT', body: { enabled } }),
  suggestions: (userId?: string) => safe<DateSuggestionsOut>(`/v1/dates/suggestions${qs({ user_id: userId })}`),
  dismiss: (personId: string) => s<void>(`/v1/dates/suggestions/${id(personId)}/dismiss`, { method: 'POST' }),
};

export const blocksApi = {
  status: (userId: string) => safe<BlockResult>(`/v1/users/${id(userId)}/block`),
  block: (userId: string) => s<BlockResult>(`/v1/users/${id(userId)}/block`, { method: 'POST' }),
  unblock: (userId: string) => s<BlockResult>(`/v1/users/${id(userId)}/block`, { method: 'DELETE' }),
};

export const challengesApi = {
  list: () => safe<{ items: Challenge[] }>('/v1/challenges'),
  create: (opponentId: string, metric: 'km' | 'workouts' = 'km', days = 7) =>
    s<Challenge>('/v1/challenges', { body: { opponent_id: opponentId, metric, days } }),
  accept: (challengeId: string) => s<Challenge>(`/v1/challenges/${id(challengeId)}/accept`, { method: 'POST' }),
  decline: (challengeId: string) => s<Challenge>(`/v1/challenges/${id(challengeId)}/decline`, { method: 'POST' }),
  cancel: (challengeId: string) => s<Challenge>(`/v1/challenges/${id(challengeId)}/cancel`, { method: 'POST' }),
};

export const notificationsApi = {
  list: (cursor?: string | null) => safe<NotificationPage>(`/v1/notifications${qs({ cursor })}`),
  unread: () => safe<{ unread: number }>('/v1/notifications/unread-count'),
  markRead: (ids?: string[]) => safe<{ unread: number }>('/v1/notifications/read', { method: 'POST', body: ids ? { ids } : {} }),
  registerPushToken: (token: string, platform: 'ios' | 'android' | 'web') =>
    safe<void>('/v1/me/push-tokens', { method: 'POST', body: { token, platform } }),
  removePushToken: (token: string) => s<void>(`/v1/me/push-tokens/${id(token)}`, { method: 'DELETE' }),
};

/** People out running (Run Module) and in a coached workout (Exercise backend) right now.
 *  Each is null when its service is not configured or does not answer. */
export async function liveCounts(): Promise<{ running: number | null; workingOut: number | null }> {
  const [running, workingOut] = await Promise.all([
    API_CONFIGURED ? api<{ running_now: number }>('/v1/live').then((r) => r.running_now, () => null) : Promise.resolve(null),
    EXERCISE_API_CONFIGURED
      ? api<{ working_out_now: number }>('/api/live', { base: EXERCISE_API_URL }).then((r) => r.working_out_now, () => null)
      : Promise.resolve(null),
  ]);
  return { running, workingOut };
}
