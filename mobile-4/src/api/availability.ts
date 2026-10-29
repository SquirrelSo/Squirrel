/**
 * Endpoint availability — which backend capabilities exist yet, decided PER ENDPOINT, never per
 * service. A capability that isn't built rejects with `EndpointUnavailableError` in every mode
 * (live or off): no fake success, no fabricated arrays. Everything else in the same
 * service keeps working.
 *
 * When a backend ships a capability, flip it in `BUILT` below — or, to try it without a code
 * change, list it in EXPO_PUBLIC_LIVE_ENDPOINTS (comma-separated, e.g. "heatmap,ambassador").
 * Built endpoints that turn out to be missing on the server (404 no_route / 501) are still
 * treated as unavailable by `featureUnavailable()` at runtime.
 *
 * Kept free of app imports so it can be unit-tested directly (availability.test.mjs).
 */

/** Campus endpoints with no backend yet (the seven), plus the shared-workout service. */
export type Capability =
  | 'sharedZones' // GET /v1/me/shared-zones (served by campus-service; opted in when it is configured)
  | 'heatmap' // GET /v1/map/heatmap?window=7d|30d (served by campus-service; opted in when it is configured)
  | 'dateSuggestions' // GET /v1/dates/suggestions, POST …/{id}/dismiss, GET|PUT /v1/dates/settings (built: Social)
  | 'media' // Social: POST /v1/media/uploads, PUT {upload_url}, POST /v1/media/{id}/complete (posts, avatars)
  | 'meetupRating' // GET /v1/meetups/{id}/rating, POST /v1/meetups/{id}/ratings (served by campus-service; opted in there)
  | 'meetupCheckIn' // POST /v1/meetups/{id}/check-in on campus-service (served; opted in when campus-service is configured, api/campus/index.ts)
  | 'ambassador' // GET | POST /v1/ambassador/application (built: Social)
  | 'profileDetails' // PATCH /v1/me with `profile_details`: retired (ADR-032). About-you saves to Exercise (api/profileDetails.ts), ungated
  | 'sharedWorkout' // Exercise: /api/workout-sessions/* + /ws/workout-sessions/{id} (built, deployed)
  | 'xpStats' // Run Module: GET /v1/xp/stats, /v1/xp/history, /v1/leaderboard/xp (ADR-033)
  | 'discover' // campus-service: GET /v1/discover[/nearby|active|challenges|crews|zones]
  | 'bubble' // campus-service: /v1/bubble (join, leave, state, nearby) + bubble.* realtime
  | 'notificationPrefs' // Social: GET|PATCH /v1/notifications/preferences, POST /v1/notifications/{id}/read, /read-all
  | 'ambassadorProgramme' // Social: /v1/ambassador/{me,referrals,tasks,leaderboard}
  | 'sharedWorkoutInvites' // Exercise: POST /api/workout-sessions/{id}/invite, /{id}/cancel, /invites/{code}/decline
  | 'buddyRemove'; // Exercise: DELETE /api/users/{me}/partner-hunt/connections/{id}

export const CAPABILITY_LABEL: Record<Capability, string> = {
  sharedZones: 'Shared zones',
  heatmap: 'The activity heatmap',
  dateSuggestions: 'Squirrel Dates',
  media: 'Photo uploads',
  meetupRating: 'Meetup ratings',
  meetupCheckIn: 'Meetup check-in',
  ambassador: 'Ambassador applications',
  profileDetails: 'Saving profile details',
  sharedWorkout: 'Shared workouts',
  xpStats: 'XP history',
  discover: 'Discover',
  bubble: 'Your bubble',
  notificationPrefs: 'Notification settings',
  ambassadorProgramme: 'The ambassador programme',
  sharedWorkoutInvites: 'Workout invites',
  buddyRemove: 'Removing a buddy',
};

/** Backend status in code. Built: Squirrel Dates, photo uploads and ambassador applications (Social); shared workouts (Exercise). */
const BUILT: Record<Capability, boolean> = {
  sharedZones: false,
  heatmap: false,
  dateSuggestions: true,
  media: true,
  meetupRating: false,
  meetupCheckIn: false,
  ambassador: true,
  profileDetails: false,
  sharedWorkout: true,
  // Built in the backend-features release (one per service). On, so they work the moment each
  // service is deployed; until then the server's 404 no_route reads as "not live yet"
  // (featureUnavailable), never as an error.
  xpStats: true,
  discover: true,
  bubble: true,
  notificationPrefs: true,
  ambassadorProgramme: true,
  sharedWorkoutInvites: true,
  buddyRemove: true,
};

/** Labels that read as one thing ("… isn’t live yet"); the rest are plural ("… aren’t live yet"). */
const SINGULAR = new Set<Capability>(['profileDetails', 'meetupCheckIn', 'discover', 'bubble', 'ambassadorProgramme', 'buddyRemove']);
const notLiveText = (c: Capability) => `${CAPABILITY_LABEL[c]} ${SINGULAR.has(c) ? 'isn’t' : 'aren’t'} live yet`;

export function parseLiveEndpoints(raw: string | undefined): Set<Capability> {
  const known = new Set(Object.keys(BUILT));
  return new Set((raw ?? '').split(',').map((s) => s.trim()).filter((s): s is Capability => known.has(s)));
}
const OPTED_IN = parseLiveEndpoints(process.env.EXPO_PUBLIC_LIVE_ENDPOINTS);

/**
 * The env opt-ins plus capabilities a configured backend is known to serve (e.g. campus-service
 * serves sharedZones and heatmap). Pass the result to gateEndpoints / endpointAvailability.
 */
export function optedInWith(extra: readonly Capability[], base: Set<Capability> = OPTED_IN): Set<Capability> {
  return new Set([...base, ...extra]);
}

export type EndpointAvailability = { status: 'available' } | { status: 'unavailable'; capability: Capability; reason: string };

export function endpointAvailability(c: Capability, opted: Set<Capability> = OPTED_IN): EndpointAvailability {
  return BUILT[c] || opted.has(c) ? { status: 'available' } : { status: 'unavailable', capability: c, reason: notLiveText(c) };
}
export const isEndpointAvailable = (c: Capability, opted?: Set<Capability>) => endpointAvailability(c, opted).status === 'available';

/** The one "this capability isn't live yet" condition. Distinct from real errors (401/403/422/5xx/network). */
export class EndpointUnavailableError extends Error {
  readonly capability: Capability;
  readonly code: string;
  constructor(capability: Capability) {
    super(notLiveText(capability));
    this.name = 'EndpointUnavailableError';
    this.capability = capability;
    this.code = `${capability}_unavailable`;
  }
}
export const isEndpointUnavailable = (e: unknown): e is EndpointUnavailableError => e instanceof EndpointUnavailableError || (e instanceof Error && e.name === 'EndpointUnavailableError');

/**
 * Wraps a service object: each method mapped to a capability rejects with
 * EndpointUnavailableError while that capability is unavailable; every other method is passed
 * through untouched. `when` lets a method gate only some calls (e.g. PATCH /v1/me only when it
 * carries `profile_details`).
 */
export type GateRule<A> = { capability: Capability; when?: (...args: A extends (...a: infer P) => unknown ? P : never) => boolean };
export function gateEndpoints<S extends object>(service: S, rules: { [K in keyof S]?: GateRule<S[K]> }, opted?: Set<Capability>): S {
  // Not a copy ({ ...service }): the "off" service is a Proxy with no own keys, and copying it
  // gives an empty object. Everything not gated is looked up on the service itself.
  const out = Object.create(service) as S;
  for (const key of Object.keys(rules) as (keyof S)[]) {
    const rule = rules[key] as { capability: Capability; when?: (...a: unknown[]) => boolean } | undefined;
    const original = service[key];
    if (!rule || typeof original !== 'function') continue;
    (out as Record<keyof S, unknown>)[key] = (...args: unknown[]) =>
      !isEndpointAvailable(rule.capability, opted) && (!rule.when || rule.when(...args))
        ? Promise.reject(new EndpointUnavailableError(rule.capability))
        : (original as (...a: unknown[]) => unknown).apply(service, args);
  }
  return out;
}
