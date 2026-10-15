/**
 * campus-service (EXPO_PUBLIC_CAMPUS_SERVICE_URL) — the map world, over REST. Only the methods the
 * hybrid routes here (CAMPUS_SERVICE_METHODS); responses are adapted to the contract in
 * campusShapes.ts where campus-service's shape differs. Routes: campus-service/docs/API.md.
 *
 *   same shape    zones, territories, zone, territoryAction, activityZones,
 *                 updatePresence, setOpenToMeet
 *   adapted       mapFeatures (GeoJSON → MapFeatures), nearbyPlayers (hidden_reason code → text + hidden_code),
 *                 activeNow (lite person → PersonCard; hidden_reason kept), sharedZones (by zone → by person;
 *                 hidden_reason kept), heatmap (7d only; {lat,lng} + low/medium/high → HeatCell),
 *                 sharedContext (404 for someone campus-service has never seen, or hidden_reason
 *                 `blocked` / `blocks_unreachable` → nothing shared),
 *                 submitActivity (fixes the server's ingest check would refuse are dropped first),
 *                 meetups / meetup (GET /v1/meetups, GET /v1/meetups/{id}: host + invitees → Meetup)
 *   same shape    meetupRating / rateMeetup (GET /v1/meetups/{id}/rating, POST /v1/meetups/{id}/ratings)
 *   same shape    checkIn (POST /v1/meetups/{id}/check-in → CheckInResult). GET /v1/meetups/{id} carries
 *                 my_check_in_at; a repeated check-in replays the first one (same checked_in_at).
 */
import { ApiError } from '@/api/client';
import { restClient } from '@/api/campus/http';
import {
  activeNowFromCampus,
  campusSupportsHeatWindow,
  heatmapFromCampus,
  heatWindowUnavailable,
  ingestAreaOf,
  mapFeaturesFromCampus,
  meetupFromCampus,
  meetupsFromCampus,
  nearbyPlayersFromCampus,
  NOTHING_SHARED,
  pointsForCampus,
  sharedContextFromCampus,
  sharedZonesFromCampus,
  type CampusActiveNow,
  type CampusConfig,
  type CampusHeatmap,
  type CampusMapFeatures,
  type CampusMeetup,
  type CampusServicePart,
  type CampusSharedZones,
  type CampusStats,
} from '@/api/campus/campusShapes';
import type * as T from '@/api/campus/types';

const id = encodeURIComponent;

export function makeCampusServiceApi(base: string): CampusServicePart {
  const { get, send } = restClient(base);
  // /v1/config is static per deploy: fetched once (a failure is retried on the next call).
  let configOnce: Promise<CampusConfig> | null = null;
  const config = () => (configOnce ??= get<CampusConfig>('/v1/config').catch((e: unknown) => {
    configOnce = null;
    throw e;
  }));
  // Your campus-service user id (a Social profile id): names a meetup by who else is in it. A failure
  // is retried on the next call; meanwhile the title falls back to everyone's names.
  let meOnce: Promise<string | null> | null = null;
  const meId = () =>
    (meOnce ??= get<{ user_id?: string }>('/v1/me').then(
      (m) => m.user_id ?? null,
      () => {
        meOnce = null;
        return null;
      },
    ));
  return {
    rawConfig: config,
    rawStats: () => get<CampusStats>('/v1/campus/stats'),
    openToMeet: async () => !!(await get<{ open_to_meet?: boolean }>('/v1/me')).open_to_meet,

    zones: async () => (await get<{ zones: T.Zone[] }>('/v1/zones')).zones,
    territories: () => get<{ territories: T.Territory[]; as_of: string }>('/v1/territories'),
    zone: (zoneId) => get<T.ZoneDetail>(`/v1/zones/${id(zoneId)}`),
    territoryAction: (zoneId, action, idempotencyKey) => send<T.TerritoryActionResult>(`/v1/zones/${id(zoneId)}/${action}`, 'POST', { idempotency_key: idempotencyKey }),

    // One-shot upload: the points are verified by campus-service itself (asynchronously). Fixes the
    // server would refuse (a jump, off campus) are dropped first, so one of them can't sink the run.
    submitActivity: async (input) => {
      const area = ingestAreaOf(await config().catch(() => null));
      const { points } = pointsForCampus(input.points, area);
      if (points.length < 2) {
        throw new ApiError(422, 'This run didn’t pass through campus, so there are no zones to check.', { code: 'no_campus_points', detail: 'This run didn’t pass through campus, so there are no zones to check.' });
      }
      return { activity_id: (await send<{ activity_id: string }>('/v1/activities', 'POST', { ...input, points })).activity_id };
    },
    // While verification runs this answers status 'processing' with no zones.
    activityZones: (activityId) => get<T.ActivityZones>(`/v1/activities/${id(activityId)}/zones`),

    mapFeatures: async () => mapFeaturesFromCampus(await get<CampusMapFeatures>('/v1/map/features')),
    nearbyPlayers: async () => nearbyPlayersFromCampus(await get<T.NearbyPlayers>('/v1/map/players')),
    updatePresence: (p) => send<{ accepted: boolean }>('/v1/map/presence', 'PUT', p),
    activeNow: async () => activeNowFromCampus(await get<CampusActiveNow>('/v1/people/active')),
    setOpenToMeet: (enabled) => send<T.OpenToMeet>('/v1/me/open-to-meet', 'PUT', { enabled }),
    // campus-service only knows people once they've used it; nobody else shares zones with you yet.
    // `blocked` (either way) → an empty context, never a sign of the block.
    sharedContext: (userId) =>
      get<Parameters<typeof sharedContextFromCampus>[0]>(`/v1/users/${id(userId)}/context`).then(sharedContextFromCampus, (e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return NOTHING_SHARED();
        throw e;
      }),

    sharedZones: async () => sharedZonesFromCampus(await get<CampusSharedZones>('/v1/me/shared-zones')),
    heatmap: async (window) => (campusSupportsHeatWindow(window) ? heatmapFromCampus(await get<CampusHeatmap>(`/v1/map/heatmap?window=${id(window)}`), window) : heatWindowUnavailable(window)),

    meetups: async () => {
      const [r, me] = await Promise.all([get<{ meetups: CampusMeetup[] }>('/v1/meetups'), meId()]);
      return meetupsFromCampus(r.meetups, me);
    },
    meetup: async (meetupId) => {
      const [m, me] = await Promise.all([get<CampusMeetup>(`/v1/meetups/${id(meetupId)}`), meId()]);
      return meetupFromCampus(m, me);
    },
    createMeetup: async (input) => {
      const [m, me] = await Promise.all([send<CampusMeetup>('/v1/meetups', 'POST', input), meId()]);
      return meetupFromCampus(m, me);
    },
    respondMeetup: async (meetupId, action) => {
      const [m, me] = await Promise.all([send<CampusMeetup>(`/v1/meetups/${id(meetupId)}/${action}`, 'POST', {}), meId()]);
      return meetupFromCampus(m, me);
    },
    // 1 h before → 6 h after the start; checking in turns an invited guest into an attendee and confirms
    // a proposed meetup (the rating gate needs both). Safety-contact semantics: features.meetup_safety_notifications.
    checkIn: (meetupId, notifySafetyContact) => send<T.CheckInResult>(`/v1/meetups/${id(meetupId)}/check-in`, 'POST', { notify_safety_contact: notifySafetyContact }),
    meetupRating: (meetupId) => get<T.MeetupRatingState>(`/v1/meetups/${id(meetupId)}/rating`),
    rateMeetup: (meetupId, input, key) => send<T.MeetupRatingResult>(`/v1/meetups/${id(meetupId)}/ratings`, 'POST', { ...input, idempotency_key: key }),
  };
}
