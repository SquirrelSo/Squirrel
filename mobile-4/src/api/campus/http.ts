/**
 * REST implementation of the campus contract. Every route is listed here and nowhere else, so
 * when the backend lands (or differs), this file is the only thing to adapt.
 *
 * Auth: the shared client attaches the same bearer token the Run Module uses.
 * Reads go through withRetry (429 / 5xx / network); writes that change ownership send an
 * idempotency key and are NOT blindly retried — the screen reconciles with the response.
 */
import { api } from '@/api/client';
import { CAMPUS_API_URL } from '@/api/config';
import { withRetry } from '@/api/endpoints';
import type * as T from '@/api/campus/types';

export const qs = (p: Record<string, string | number | undefined>) => {
  const s = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return s ? `?${s}` : '';
};
const id = encodeURIComponent;

/** GET with retries (429 / 5xx / network) and a plain write, both against `base`. */
export function restClient(base: string) {
  return {
    get: <R,>(path: string) => withRetry(() => api<R>(path, { base })),
    send: <R,>(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown) => api<R>(path, { base, method, body }),
  };
}

/** The full contract over REST at `base` (a dedicated campus backend). */
export function makeHttpCampusApi(base: string): T.CampusApi {
  const { get, send } = restClient(base);
  return {
    config: () => get<T.AppConfig>('/v1/config'),
    stats: () => get<T.LaunchStats>('/v1/campus/stats'),

    me: () => get<T.Me>('/v1/me'),
    updateMe: (patch) => send<T.Me>('/v1/me', 'PATCH', patch),
    setOpenToMeet: (enabled) => send<T.OpenToMeet>('/v1/me/open-to-meet', 'PUT', { enabled }),
    profile: (userId) => get<T.Profile>(`/v1/users/${id(userId)}`),
    sharedContext: (userId) => get<T.SharedContext>(`/v1/users/${id(userId)}/context`),
    badges: async () => (await get<{ badges: T.Badge[] }>('/v1/me/badges')).badges,

    zones: async () => (await get<{ zones: T.Zone[] }>('/v1/zones')).zones,
    territories: () => get<{ territories: T.Territory[]; as_of: string }>('/v1/territories'),
    zone: (zoneId) => get<T.ZoneDetail>(`/v1/zones/${id(zoneId)}`),
    territoryAction: (zoneId, action, idempotencyKey) => send<T.TerritoryActionResult>(`/v1/zones/${id(zoneId)}/${action}`, 'POST', { idempotency_key: idempotencyKey }),

    submitActivity: (input) => send<{ activity_id: string }>('/v1/activities', 'POST', input),
    activityZones: (activityId) => get<T.ActivityZones>(`/v1/runs/${id(activityId)}/zones`),

    crews: ({ q, scope }) => get<T.Page<T.Crew>>(`/v1/crews${qs({ q, scope })}`),
    crew: (crewId) => get<T.CrewDetail>(`/v1/crews/${id(crewId)}`),
    joinCrew: (crewId) => send<T.Crew>(`/v1/crews/${id(crewId)}/join`, 'POST'),
    leaveCrew: (crewId) => send<T.Crew>(`/v1/crews/${id(crewId)}/leave`, 'POST'),
    createCrew: (input) => send<T.Crew>('/v1/crews', 'POST', input),

    events: ({ scope }) => get<T.Page<T.EventSummary>>(`/v1/events${qs({ scope })}`),
    event: (eventId) => get<T.EventDetail>(`/v1/events/${id(eventId)}`),
    rsvp: (eventId, going) => send<T.EventDetail>(`/v1/events/${id(eventId)}/rsvp`, going ? 'PUT' : 'DELETE'),
    createEvent: (input) => send<T.EventDetail>('/v1/events', 'POST', input),

    suggestedPeople: async (mode) => (await get<{ people: T.PersonCard[] }>(`/v1/people/suggested${qs({ mode })}`)).people,
    activeNow: () => get<T.ActiveNow>('/v1/people/active'),

    challengeTypes: async () => (await get<{ types: T.ChallengeTypeInfo[] }>('/v1/challenge-invites/types')).types,
    invites: async (box) => (await get<{ invites: T.ChallengeInvite[] }>(`/v1/challenge-invites${qs({ box })}`)).invites,
    createInvite: (input) => send<T.ChallengeInvite>('/v1/challenge-invites', 'POST', input),
    respondInvite: (inviteId, action) => send<T.ChallengeInvite>(`/v1/challenge-invites/${id(inviteId)}/${action}`, 'POST'),

    squirrelBoard: (period, limit = 10) => get<T.SquirrelBoard>(`/v1/leaderboards/squirrels${qs({ period, limit })}`),
    hostelBoard: (period) => get<T.HostelBoard>(`/v1/leaderboards/hostels${qs({ period })}`),

    mapFeatures: () => get<T.MapFeatures>('/v1/map/features'),
    nearbyPlayers: () => get<T.NearbyPlayers>('/v1/map/players'),
    zonePlayers: async (zoneId) => (await get<{ players: T.PersonSummary[] }>(`/v1/zones/${id(zoneId)}/players`)).players,
    updatePresence: (p) => send<{ accepted: boolean }>('/v1/map/presence', 'PUT', p),
    searchPeople: async (q) => (await get<{ people: T.PersonSummary[] }>(`/v1/people/search${qs({ q })}`)).people,

    pokeStatus: (userId) => get<T.Relationship>(`/v1/pokes/status/${id(userId)}`),
    sendPoke: (userId, key) => send<T.PokeResult>('/v1/pokes', 'POST', { to_user_id: userId, idempotency_key: key }),
    // Same endpoint: the backend decides whether this completes a mutual poke. `reply` is a hint for analytics.
    pokeBack: (userId, key) => send<T.PokeResult>('/v1/pokes', 'POST', { to_user_id: userId, idempotency_key: key, reply: true }),
    incomingPokes: async () => (await get<{ pokes: T.IncomingPoke[] }>('/v1/pokes/incoming')).pokes,
    friendshipStatus: (userId) => get<{ user_id: string; friends: boolean; since: string | null }>(`/v1/friends/status/${id(userId)}`),

    notifications: async (cursor) => {
      const page = await get<{ items: T.AppNotification[]; unread: number; next_cursor?: string | null }>(`/v1/notifications${cursor ? `?cursor=${id(cursor)}` : ''}`);
      return { ...page, next_cursor: page.next_cursor ?? null };
    },
    markNotificationsRead: (ids) => send<{ unread: number }>('/v1/notifications/read', 'POST', { ids }),

    // Dev B — shared zones (the per-person overlap is sharedContext above), heatmap, Squirrel Dates
    sharedZones: () => get<T.SharedZonesIndex>('/v1/me/shared-zones'),
    heatmap: (window) => get<T.Heatmap>(`/v1/map/heatmap${qs({ window })}`),
    dateSuggestions: (forUserId) => get<T.DateSuggestions>(`/v1/dates/suggestions${qs({ user_id: forUserId })}`),
    dismissDateSuggestion: async (suggestionId) => {
      await send<void>(`/v1/dates/suggestions/${id(suggestionId)}/dismiss`, 'POST');
      return { dismissed: true };
    },
    dateSettings: () => get<T.DateSettings>('/v1/dates/settings'),
    setDateSettings: (enabled) => send<T.DateSettings>('/v1/dates/settings', 'PUT', { enabled }),
    blockStatus: (userId) => get<T.BlockState>(`/v1/users/${id(userId)}/block`),
    setBlocked: (userId, blocked) => send<T.BlockState>(`/v1/users/${id(userId)}/block`, blocked ? 'POST' : 'DELETE'),

    // Dev A — meetup ratings, ambassadors (photo uploads go to Social: api/campus/media.ts)
    meetupRating: (meetupId) => get<T.MeetupRatingState>(`/v1/meetups/${id(meetupId)}/rating`),
    rateMeetup: (meetupId, input, key) => send<T.MeetupRatingResult>(`/v1/meetups/${id(meetupId)}/ratings`, 'POST', { ...input, idempotency_key: key }),
    ambassador: () => get<T.AmbassadorState>('/v1/ambassador/application'),
    applyAmbassador: (answers, key) => send<T.AmbassadorApplication>('/v1/ambassador/application', 'POST', { answers, idempotency_key: key }),

    meetups: async () => (await get<{ meetups: T.Meetup[] }>('/v1/meetups')).meetups,
    meetup: (meetupId) => get<T.Meetup>(`/v1/meetups/${id(meetupId)}`),
    createMeetup: (input) => send<T.Meetup>('/v1/meetups', 'POST', input),
    respondMeetup: (meetupId, action) => send<T.Meetup>(`/v1/meetups/${id(meetupId)}/${action}`, 'POST', {}),
    checkIn: (meetupId, notify) => send<T.CheckInResult>(`/v1/meetups/${id(meetupId)}/check-in`, 'POST', { notify_safety_contact: notify }),
  };
}

export const httpCampusApi: T.CampusApi = makeHttpCampusApi(CAMPUS_API_URL);

/** Human list of routes, for docs and the "missing endpoints" report. */
export const CAMPUS_ROUTES = [
  'GET /v1/config',
  'GET /v1/campus/stats',
  'GET /v1/me',
  'PATCH /v1/me',
  'PUT /v1/me/open-to-meet',
  'GET /v1/me/badges',
  'GET /v1/users/{id}',
  'GET /v1/users/{id}/context',
  'GET /v1/zones',
  'GET /v1/territories',
  'GET /v1/zones/{id}',
  'POST /v1/zones/{id}/claim | steal | defend',
  'GET /v1/runs/{id}/zones',
  'POST /v1/activities (dev/mock recorder only)',
  'GET /v1/crews, GET /v1/crews/{id}, POST /v1/crews, POST /v1/crews/{id}/join | leave',
  'GET /v1/events, GET /v1/events/{id}, POST /v1/events, PUT|DELETE /v1/events/{id}/rsvp',
  'GET /v1/people/suggested?mode=friends|date',
  'GET /v1/people/active',
  'GET /v1/challenge-invites/types, GET|POST /v1/challenge-invites, POST /v1/challenge-invites/{id}/accept | decline | cancel',
  'GET /v1/leaderboards/squirrels, GET /v1/leaderboards/hostels',
  'GET /v1/meetups, GET /v1/meetups/{id}, POST /v1/meetups/{id}/check-in',
  'GET /v1/map/features, GET /v1/map/players, PUT /v1/map/presence, GET /v1/zones/{id}/players, GET /v1/people/search?q=',
  'GET /v1/pokes/status/{id}, POST /v1/pokes, GET /v1/pokes/incoming, GET /v1/friends/status/{id}',
  'GET /v1/notifications, POST /v1/notifications/read',
  // NOT LIVE YET — gated per endpoint in api/availability.ts (reject as unavailable in every mode)
  // Expected from Dev B
  'GET /v1/me/shared-zones',
  'GET /v1/map/heatmap?window=1h|24h|7d',
  'GET /v1/dates/suggestions?user_id=, POST /v1/dates/suggestions/{id}/dismiss, GET|PUT /v1/dates/settings',
  'GET|POST|DELETE /v1/users/{id}/block',
  // Expected from Dev A
  'GET /v1/meetups/{id}/rating, POST /v1/meetups/{id}/ratings',
  'GET|POST /v1/ambassador/application',
  'WS realtime_url (territory.updated, stats.updated, invite.updated, event.updated, active.updated, poke.received, relationship.updated, friendship.created, notification.created, players.updated)',
] as const;
