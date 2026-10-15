/**
 * Entry point for the campus social backend. Screens import `campusApi` from here and never
 * call fetch themselves.
 *
 *   live  → REST (api/campus/http.ts) against CAMPUS_API_URL, or the Social service through
 *           the adapter in api/campus/social.ts
 *   off   → every call rejects with "not live yet"; screens show that state, never fake data
 *
 * On top of the source, availability is decided PER ENDPOINT (api/availability.ts): the seven
 * campus endpoints with no backend yet reject with EndpointUnavailableError in every mode, while
 * the rest of the service keeps working. One missing endpoint never takes down another.
 */
import { endpointAvailability as availabilityOf, EndpointUnavailableError, gateEndpoints, isEndpointUnavailable, optedInWith, type Capability } from '@/api/availability';
import { ApiError, getApiToken } from '@/api/client';
import { CAMPUS_API_CONFIGURED, CAMPUS_ON_SOCIAL, CAMPUS_SERVICE_CONFIGURED, CAMPUS_SERVICE_URL, DEDICATED_CAMPUS_API, REALTIME_URL } from '@/api/config';
import { campusServiceIgnoredReason, makeHybridCampusApi } from '@/api/campus/campusShapes';
import { makeCampusServiceApi } from '@/api/campus/campusService';
import { httpCampusApi } from '@/api/campus/http';
import { socialCampusApi } from '@/api/campus/social';
import type { CampusApi, RealtimeMessage } from '@/api/campus/types';

/**
 * There is no mock or simulated campus backend in any build. 'mock' stays in the type only so the
 * Run Module's existing `CAMPUS_SOURCE === 'mock'` check keeps compiling unchanged (always false).
 */
export type CampusSource = 'live' | 'mock' | 'off';

export const CAMPUS_SOURCE: CampusSource = CAMPUS_API_CONFIGURED ? 'live' : 'off';

export const NOT_LIVE = 'not_live';

const offApi: CampusApi = new Proxy({} as CampusApi, {
  get: () => () => Promise.reject(new ApiError(0, 'Campus features aren’t live yet', { code: NOT_LIVE, detail: 'Campus features aren’t live yet' })),
});

/**
 * Split by feature: with the Social service live AND campus-service configured
 * (EXPO_PUBLIC_CAMPUS_SERVICE_URL), campus-service serves the map world (zones, territory, runs →
 * zones, map players / presence, Active now, Open to Meet, shared zones, heatmap) and Social keeps
 * everything else (api/campus/campusShapes.ts → makeHybridCampusApi). Unset: exactly as before.
 */
export const CAMPUS_MAP_ON_SERVICE = CAMPUS_SOURCE === 'live' && CAMPUS_ON_SOCIAL && CAMPUS_SERVICE_CONFIGURED;

// Configured but not used is a deploy mistake, not a state to run in silently.
const ignored = campusServiceIgnoredReason({ serviceConfigured: CAMPUS_SERVICE_CONFIGURED, source: CAMPUS_SOURCE, onSocial: CAMPUS_ON_SOCIAL, dedicatedCampusApi: DEDICATED_CAMPUS_API });
if (ignored) console.warn(`[campus] EXPO_PUBLIC_CAMPUS_SERVICE_URL is set but not used: ${ignored}. Zones, map and territory stay on the current campus source.`);

/** Live: a dedicated campus backend (EXPO_PUBLIC_CAMPUS_API_URL) speaks the contract itself; the
 *  Social service is adapted to it (api/campus/social.ts), optionally with campus-service's map world. */
const sourceApi: CampusApi =
  CAMPUS_SOURCE === 'live'
      ? CAMPUS_ON_SOCIAL
        ? CAMPUS_MAP_ON_SERVICE
          ? makeHybridCampusApi(socialCampusApi, makeCampusServiceApi(CAMPUS_SERVICE_URL))
          : socialCampusApi
        : httpCampusApi
      : offApi;

/** Capabilities campus-service serves on top of the env opt-ins; undefined (the env default) otherwise. */
const OPTED: Set<Capability> | undefined = CAMPUS_MAP_ON_SERVICE ? optedInWith(['sharedZones', 'heatmap', 'meetupRating', 'meetupCheckIn']) : undefined;

/** Method → capability for every endpoint that isn't built yet. Everything unlisted passes through. */
export const campusApi: CampusApi = gateEndpoints(sourceApi, {
  sharedZones: { capability: 'sharedZones' },
  heatmap: { capability: 'heatmap' },
  dateSuggestions: { capability: 'dateSuggestions' },
  dismissDateSuggestion: { capability: 'dateSuggestions' },
  dateSettings: { capability: 'dateSuggestions' },
  setDateSettings: { capability: 'dateSuggestions' },
  // campus-service serves GET /v1/meetups/{id}/rating and POST …/ratings (it owns meetups + rating,
  // ADR-032), so it's on there (OPTED above); other sources stay gated until they serve them.
  meetupRating: { capability: 'meetupRating' },
  rateMeetup: { capability: 'meetupRating' },
  // campus-service serves POST /v1/meetups/{id}/check-in (OPTED above). The gate applies only there;
  // other sources' check-in was always live.
  checkIn: { capability: 'meetupCheckIn', when: () => CAMPUS_MAP_ON_SERVICE },
  ambassador: { capability: 'ambassador' },
  applyAmbassador: { capability: 'ambassador' },
  // PATCH /v1/me itself is live; only the profile_details field has no backend yet.
  updateMe: { capability: 'profileDetails', when: (patch) => patch.profile_details !== undefined },
}, OPTED);

export { EndpointUnavailableError, isEndpointUnavailable };
export { CAPABILITY_LABEL, type Capability } from '@/api/availability';
/** Availability as the campus API sees it (campus-service's capabilities included when it's configured). */
export const endpointAvailability = (c: Capability) => availabilityOf(c, OPTED);
export const isEndpointAvailable = (c: Capability) => endpointAvailability(c).status === 'available';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorKind = 'offline' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'not_live' | 'server';

export function errorKind(e: unknown): ErrorKind {
  if (isEndpointUnavailable(e)) return 'not_live';
  if (!(e instanceof ApiError)) return 'server';
  const code = errorCode(e);
  if (code === NOT_LIVE) return 'not_live';
  if (e.status === 0) return 'offline';
  if (e.status === 401) return 'unauthorized';
  if (e.status === 403) return 'forbidden';
  if (e.status === 404) return 'not_found';
  if (e.status === 409) return 'conflict';
  if (e.status === 422 || e.status === 400) return 'invalid';
  return 'server';
}

export function errorCode(e: unknown): string | null {
  const b = e instanceof ApiError ? (e.body as { code?: unknown; detail?: { code?: unknown } | unknown } | undefined) : undefined;
  if (typeof b?.code === 'string') return b.code;
  // Exercise puts it in detail: { detail: { code, message } }. Without this, its 404 not_found reads
  // as "route not deployed" (featureUnavailable) instead of "not found".
  const d = b?.detail as { code?: unknown } | null | undefined;
  return d && typeof d === 'object' && typeof d.code === 'string' ? d.code : null;
}

/**
 * A feature whose backend isn't there yet: campus off, the route not deployed (404 without a
 * resource code), 501, or 503 with an "unavailable" code. Screens show an unavailable state
 * for these instead of an error — and never pretend the feature works.
 */
export function featureUnavailable(e: unknown): boolean {
  const kind = errorKind(e);
  if (kind === 'not_live') return true;
  if (!(e instanceof ApiError)) return false;
  const code = errorCode(e);
  if (e.status === 404) return code == null || code === 'no_route';
  if (e.status === 501) return true;
  return e.status === 503 && !!code && code.endsWith('unavailable');
}

export function errorText(e: unknown): string {
  switch (errorKind(e)) {
    case 'offline':
      return e instanceof ApiError && e.message === 'Request timed out' ? 'That took too long. Check your connection and try again.' : 'You’re offline. Check your connection and try again.';
    case 'unauthorized':
      return 'Your session expired. Sign in again.';
    case 'not_live':
      return isEndpointUnavailable(e) ? `${e.message}.` : 'Campus features aren’t live yet.';
    default:
      return e instanceof Error && e.message ? e.message : 'Something went wrong.';
  }
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

type Handler = (m: RealtimeMessage) => void;
const handlers = new Set<Handler>();
let socket: WebSocket | null = null;
let socketUrl: string | null = REALTIME_URL || null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** How live updates arrive: a socket, or refresh-on-focus (no push channel). */
export function realtimeMode(): 'socket' | 'focus' {
  return socketUrl ? 'socket' : 'focus';
}

/** The backend's /v1/config may announce the socket URL; call this once it's known. */
export function setRealtimeUrl(url: string | null) {
  if (REALTIME_URL || !url || url === socketUrl) return;
  socketUrl = url;
  if (handlers.size) connect();
}

const dispatch = (m: RealtimeMessage) => handlers.forEach((h) => h(m));

function connect() {
  if (!socketUrl || socket || CAMPUS_SOURCE !== 'live') return;
  try {
    const ws = new WebSocket(socketUrl);
    socket = ws;
    ws.onopen = () => {
      retry = 0;
      const token = getApiToken();
      // Auth as the first frame so the token never lands in URLs or proxy logs.
      if (token) ws.send(JSON.stringify({ type: 'auth', token }));
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['territories', 'stats', 'invites', 'events', 'active'] }));
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as RealtimeMessage;
        if (m && typeof m.type === 'string') dispatch(m);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      socket = null;
      if (!handlers.size) return;
      // Back off 1s → 2s → … → 30s; never hammer the server.
      const wait = Math.min(30_000, 1000 * 2 ** retry++);
      retryTimer = setTimeout(connect, wait);
    };
    ws.onerror = () => ws.close();
  } catch {
    socket = null;
  }
}

function disconnect() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  socket?.close();
  socket = null;
}

/** Subscribe to live updates. The connection is shared and closes when nobody listens. */
export function subscribeRealtime(h: Handler): () => void {
  handlers.add(h);
  if (handlers.size === 1) connect();
  return () => {
    handlers.delete(h);
    if (!handlers.size) disconnect();
  };
}

export { CAMPUS_ROUTES } from '@/api/campus/http';
export { discoverApi, discoverLive, type DiscoverBattle, type DiscoverItem } from '@/api/campus/discover';
export { bubbleApi, bubbleLive } from '@/api/campus/bubble';
export type * from '@/api/campus/types';
