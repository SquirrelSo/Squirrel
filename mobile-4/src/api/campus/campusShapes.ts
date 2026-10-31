/**
 * campus-service → campus contract (api/campus/types.ts): the shape mapping and the hybrid
 * composition used when the Social service AND campus-service are both configured.
 *
 * Split by feature (docs/decisions/ADR-032-service-ownership.md): campus-service owns the map world
 * (zones, territory and claim / steal / defend, activities → zone eligibility, map players and
 * presence, Active now, Open to Meet, shared zones, the heatmap) and meetups with their post-meetup
 * rating; the Social service keeps everything else. User ids are the same on both (campus-
 * service returns Social profile ids and Social names), so nothing here translates ids.
 *
 * Kept free of runtime imports so it can be unit-tested directly (api/campusService.test.mjs).
 */
import type * as T from '@/api/campus/types';

/** Contract methods served by campus-service in the hybrid. Everything else stays on Social. */
export const CAMPUS_SERVICE_METHODS = [
  'zones',
  'territories',
  'zone',
  'territoryAction',
  'submitActivity',
  'activityZones',
  'mapFeatures',
  'nearbyPlayers',
  'updatePresence',
  'activeNow',
  'setOpenToMeet',
  'sharedZones',
  'heatmap',
  'sharedContext',
  // meetups, check-in and post-meetup rating (ADR-032): campus-service serves all of them.
  'meetups',
  'meetup',
  'createMeetup',
  'respondMeetup',
  'checkIn',
  'meetupRating',
  'rateMeetup',
] as const satisfies readonly (keyof T.CampusApi)[];

export type CampusServiceMethod = (typeof CAMPUS_SERVICE_METHODS)[number];

/** What the hybrid needs from campus-service: the routed methods (already in contract shape) plus raw config / stats / me. */
export type CampusServicePart = Pick<T.CampusApi, CampusServiceMethod> & {
  rawConfig(): Promise<CampusConfig>;
  rawStats(): Promise<CampusStats>;
  /** campus-service's own `open_to_meet` (it owns Open to Meet in the hybrid). */
  openToMeet(): Promise<boolean>;
};

/** Geometry that nobody has surveyed yet: drawn as approximate, still claimable. */
export const PLACEHOLDER_GEOMETRY = 'dev_placeholder';
export const isPlaceholderZone = (z: { geometry_source?: string | null } | null | undefined) => z?.geometry_source === PLACEHOLDER_GEOMETRY;

// ---------------------------------------------------------------------------
// Wire shapes (only the fields read here; see campus-service/docs/API.md)
// ---------------------------------------------------------------------------

export type CampusConfig = {
  campus?: { center?: [number, number] | null; max_radius_m?: number | null } | null;
  features?: { defend?: boolean; open_to_meet?: boolean } | null;
  realtime_url?: string | null;
};
export type CampusStats = { zones_total?: number; zones_claimed?: number };

type CampusPerson = { user_id: string; display_name: string; avatar_url: string | null; hostel: string | null; connection_mode?: T.ConnectionMode | null; bio?: string | null };

export type CampusActiveNow = CampusHidden & {
  active_now: number;
  active: { person: CampusPerson; activity: T.ActivePerson['activity']; proximity: T.Proximity | null }[];
  nearby: { person: CampusPerson; activity: T.ActivePerson['activity']; proximity: T.Proximity | null }[];
  as_of: string;
};

export type CampusSharedZones = CampusHidden & {
  zones: { zone: { id: string; name: string; kind?: string }; people: (CampusPerson & { activity?: 'sometimes' | 'often' })[] }[];
};

export type CampusHeatmap = {
  window?: string;
  grid_size_m?: number;
  suppression_threshold_users?: number;
  cells: { center: { lat: number; lng: number } | T.LatLng; intensity: 'low' | 'medium' | 'high' | string }[];
};

/** A campus-service meetup (GET /v1/meetups → { meetups }, GET /v1/meetups/{id}). */
export type CampusMeetup = {
  id: string;
  created_by: string;
  zone_id: string | null;
  zone: { id: string; name: string } | null;
  place_text: string | null;
  starts_at: string;
  status: 'proposed' | 'confirmed' | 'cancelled' | 'completed';
  participants: { user_id: string; role: 'host' | 'guest'; status: 'invited' | 'accepted' | 'declined'; responded_at: string | null; checked_in?: boolean; person: (T.PersonLite & { open_to_meet?: boolean }) | null }[];
  /** Read back once campus-service sends them (check-in is otherwise only known from its response). */
  my_check_in_at?: string | null;
};

/** Fields campus-service adds to a list it hid or emptied (Active now, shared zones, a person's context). */
type CampusHidden = { visible?: boolean; hidden_reason?: string | null };

type GeoPolygon = { type: string; coordinates: number[][][] };
export type CampusMapFeatures =
  | T.MapFeatures
  | { type: 'FeatureCollection'; features: { id?: string | number; geometry?: GeoPolygon | null; properties?: (Partial<T.Zone> & { polygon?: T.LatLng[] }) | null }[] };

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * campus-service sends `blocks_unreachable` (Social's block list couldn't be checked). Its old name,
 * `blocks_unavailable`, is accepted as an alias only. The canonical key must NOT end in
 * "unavailable": featureUnavailable() treats such codes as "feature not built", which would show
 * "Not live yet" during a Social outage instead of the retry message.
 */
const HIDDEN_ALIAS: Record<string, T.HiddenCode> = { blocks_unavailable: 'blocks_unreachable' };
const HIDDEN_REASON: Record<string, string> = {
  open_to_meet_off: 'Turn on Open to Meet to see Squirrels near you.',
  blocks_unreachable: 'Can’t check your block list right now — try again in a moment.',
};
/** An unknown code (e.g. from a newer server): honest, and never the raw code. */
export const HIDDEN_REASON_FALLBACK = 'Some Squirrels can’t be shown right now. Try again in a moment.';

/** campus-service's `hidden_reason` code, normalised (old `blocks_unavailable` → `blocks_unreachable`). */
export const hiddenCodeOf = (r: string | null | undefined): T.HiddenCode | null => (r ? (HIDDEN_ALIAS[r] ?? r) : null);
/** campus-service sends a code; screens show this text (and pick an action from the code). */
export const hiddenReasonText = (r: string | null | undefined): string | null => {
  const code = hiddenCodeOf(r);
  return code ? (HIDDEN_REASON[code] ?? HIDDEN_REASON_FALLBACK) : null;
};
/**
 * What a screen offers next to a hidden / emptied list: Open to Meet off → 'settings' (turn it on);
 * the block list couldn't be checked, or a code this app doesn't know → 'retry'; nothing to show → null.
 */
export function hiddenActionFor(code: T.HiddenCode | null | undefined): 'settings' | 'retry' | null {
  if (!code || code === 'blocked') return null;
  return code === 'open_to_meet_off' ? 'settings' : 'retry';
}
const hidden = (r: string | null | undefined) => ({ hidden_reason: hiddenReasonText(r), hidden_code: hiddenCodeOf(r) });

/**
 * Map players. With `blocks_unreachable` the list is empty (fail-closed) while `visible` stays true,
 * so the map must show the reason whenever `hidden_code` is set, not only when !visible.
 */
export function nearbyPlayersFromCampus(raw: T.NearbyPlayers): T.NearbyPlayers {
  return { ...raw, players: raw.players ?? [], ...hidden(raw.hidden_reason) };
}

export const NOTHING_SHARED = (): T.SharedContext => ({ shared_zones: [], shared_crews: [], shared_events: [], icebreakers: [] });

/**
 * A person's context. `blocked` (either direction) → just an empty context: nothing reveals the block.
 * `blocks_unreachable` → empty too (fail-closed), but with the reason, so the screen says it couldn't
 * check rather than "no common ground".
 */
export function sharedContextFromCampus(raw: T.SharedContext & CampusHidden): T.SharedContext {
  if (raw.hidden_reason) return hiddenCodeOf(raw.hidden_reason) === 'blocked' ? NOTHING_SHARED() : { ...NOTHING_SHARED(), ...hidden(raw.hidden_reason) };
  return { shared_zones: raw.shared_zones ?? [], shared_crews: raw.shared_crews ?? [], shared_events: raw.shared_events ?? [], icebreakers: raw.icebreakers ?? [] };
}

function personCard(p: CampusPerson, activity: T.ActivePerson['activity']): T.PersonCard {
  const top = activity?.type === 'run' || activity?.type === 'walk' ? activity.type : null;
  return {
    user_id: p.user_id,
    display_name: p.display_name,
    avatar_url: p.avatar_url ?? null,
    hostel: p.hostel ?? null,
    connection_mode: p.connection_mode ?? null,
    bio: p.bio ?? null,
    // campus-service sends no activity history or shared context on these cards.
    activity: { top_activity: top, runs_30d: 0, distance_30d_m: 0, usual_time: null },
    shared: { shared_zones: [], shared_crews: [], shared_events: [], icebreakers: [] },
    match_reason: null,
  };
}

/** Active now: campus-service's person is a PersonLite + mode/bio; the app's card needs the rest. */
export function activeNowFromCampus(raw: CampusActiveNow): T.ActiveNow {
  const row = (a: CampusActiveNow['active'][number]): T.ActivePerson => ({ person: personCard(a.person, a.activity ?? null), activity: a.activity ?? null, proximity: a.proximity ?? null });
  // The reason rides along: an empty list with `blocks_unreachable` must say why, not look like nobody's around.
  return { active_now: raw.active_now ?? 0, active: (raw.active ?? []).map(row), nearby: (raw.nearby ?? []).map(row), as_of: raw.as_of, ...hidden(raw.hidden_reason) };
}

/**
 * Shared zones: campus-service groups by zone ({ zones: [{ zone, people[] }] }); the app lists
 * people ({ people: [{ person, shared_zones_count, top_zone }] }). The top zone is one where they
 * are active "often" when there is one. Most shared zones first.
 */
export function sharedZonesFromCampus(raw: CampusSharedZones): T.SharedZonesIndex {
  const byPerson = new Map<string, { row: T.SharedZonesPerson; best: number }>();
  for (const z of raw.zones ?? []) {
    for (const p of z.people ?? []) {
      let e = byPerson.get(p.user_id);
      if (!e) {
        e = { row: { person: { user_id: p.user_id, display_name: p.display_name, avatar_url: p.avatar_url ?? null, hostel: p.hostel ?? null }, shared_zones_count: 0, top_zone: null }, best: 0 };
        byPerson.set(p.user_id, e);
      }
      e.row.shared_zones_count += 1;
      const score = p.activity === 'often' ? 2 : 1;
      if (score > e.best) {
        e.best = score;
        e.row.top_zone = { zone_id: z.zone.id, zone_name: z.zone.name };
      }
    }
  }
  const people = [...byPerson.values()].map((e) => e.row).sort((a, b) => b.shared_zones_count - a.shared_zones_count || a.person.display_name.localeCompare(b.person.display_name));
  // campus-service has no shared-zones visibility switch; `blocks_unreachable` empties the list (fail-closed).
  return { people, visible: raw.visible ?? true, ...hidden(raw.hidden_reason) };
}

/** campus-service serves the 7-day window (and 30d, which the app doesn't offer). */
export const CAMPUS_HEAT_WINDOWS: T.HeatWindow[] = ['7d'];
export const campusSupportsHeatWindow = (w: T.HeatWindow) => CAMPUS_HEAT_WINDOWS.includes(w);

const HEAT_LEVEL: Record<string, T.HeatLevel> = { low: 'low', medium: 'active', high: 'high' };
const HEAT_INTENSITY: Record<T.HeatLevel, number> = { low: 0.33, active: 0.66, high: 1 };

/** A window campus-service doesn't aggregate: say so instead of showing another window's data. */
export function heatWindowUnavailable(window: T.HeatWindow, now = new Date().toISOString()): T.Heatmap {
  return { available: false, reason: 'Campus heat covers the last 7 days. Switch to 7d.', window, generated_at: now, cells: [], min_people_per_cell: null };
}

/**
 * Heatmap: campus-service sends `{ window, grid_size_m, suppression_threshold_users, cells: [{ center: {lat,lng},
 * intensity: 'low'|'medium'|'high' }] }`; the app draws `HeatCell`s (LatLng centre, radius, 0..1 intensity, level).
 */
export function heatmapFromCampus(raw: CampusHeatmap, window: T.HeatWindow, now = new Date().toISOString()): T.Heatmap {
  const grid = raw.grid_size_m ?? 100;
  const cells = (raw.cells ?? []).map((c): T.HeatCell => {
    const center: T.LatLng = Array.isArray(c.center) ? c.center : [c.center.lat, c.center.lng];
    const level = HEAT_LEVEL[c.intensity] ?? 'low';
    // A glow that covers its grid cell (half-diagonal ≈ 0.71 × side).
    return { id: `${center[0].toFixed(5)},${center[1].toFixed(5)}`, center, radius_m: Math.round(grid * 0.75), intensity: HEAT_INTENSITY[level], level, zone_id: null };
  });
  return { available: true, reason: null, window: raw.window ?? window, generated_at: now, cells, min_people_per_cell: raw.suppression_threshold_users ?? null };
}

/** A GeoJSON ring ([lng, lat], closed) → the app's open [lat, lng] ring. */
function ringFrom(g: GeoPolygon | null | undefined): T.LatLng[] {
  const ring = g?.coordinates?.[0] ?? [];
  const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  return open.map(([lng, lat]) => [lat, lng] as T.LatLng);
}

/**
 * Map features: campus-service's `/v1/map/features` is a GeoJSON FeatureCollection of active zones
 * (with `geometry_source` and public territory state) — it has no roads, buildings, terrain or POIs.
 * The contract's base-map arrays come back empty (the map draws zones on plain ground) and the zones
 * ride along in `zones`. A server that already speaks the contract passes through.
 */
export function mapFeaturesFromCampus(raw: CampusMapFeatures): T.MapFeatures {
  if ('roads' in raw && Array.isArray(raw.roads)) return raw;
  const features = 'features' in raw && Array.isArray(raw.features) ? raw.features : [];
  const zones: T.Zone[] = [];
  for (const f of features) {
    const p = f.properties ?? {};
    const id = p.id ?? (f.id != null ? String(f.id) : null);
    const polygon = p.polygon?.length ? p.polygon : ringFrom(f.geometry);
    if (!id || !p.name || polygon.length < 3) continue;
    const centroid = p.centroid ?? ([polygon.reduce((s, q) => s + q[0], 0) / polygon.length, polygon.reduce((s, q) => s + q[1], 0) / polygon.length] as T.LatLng);
    zones.push({ id, name: p.name, short_name: p.short_name ?? null, kind: p.kind ?? 'landmark', polygon, centroid, hostel: p.hostel ?? null, geometry_source: p.geometry_source ?? null });
  }
  return { roads: [], buildings: [], terrain: [], pois: [], zones };
}

/** campus-service runs no check-in window: the app opens it 1 h before the start and closes it 6 h after. */
const CHECK_IN_OPENS_BEFORE_MS = 3600_000;
const CHECK_IN_CLOSES_AFTER_MS = 6 * 3600_000;

/**
 * A campus-service meetup → the app's Meetup. Title: who you're meeting ("Meetup with Aanya & Ravi").
 * Attendees: host + invitees who haven't declined, each marked confirmed or only invited. Your role
 * and RSVP decide what you can do. Check-ins are read when campus-service sends them (`checked_in`,
 * `my_check_in_at`); until then nobody shows as checked in.
 */
export function meetupFromCampus(m: CampusMeetup, meId: string | null): T.Meetup {
  const going = (m.participants ?? []).filter((p) => p.status !== 'declined');
  const others = going.filter((p) => p.user_id !== meId).map((p) => p.person?.display_name).filter((n): n is string => !!n);
  const where = m.zone?.name ?? m.place_text ?? null;
  const title = others.length ? `Meetup with ${others.length > 2 ? `${others.slice(0, 2).join(', ')} +${others.length - 2}` : others.join(' & ')}` : where ? `Meetup at ${where}` : 'Meetup';
  const start = Date.parse(m.starts_at);
  const mine = meId ? (m.participants ?? []).find((p) => p.user_id === meId) : undefined;
  return {
    id: m.id,
    title,
    starts_at: m.starts_at,
    location: { name: where ?? 'On campus', zone_id: m.zone_id ?? m.zone?.id ?? null },
    event_id: null,
    attendees: going.map((p) => ({ user_id: p.user_id, display_name: p.person?.display_name ?? 'Squirrel', avatar_url: p.person?.avatar_url ?? null, hostel: p.person?.hostel ?? null, checked_in: p.checked_in === true, rsvp: p.status === 'accepted' ? 'accepted' : 'invited', host: p.role === 'host' })),
    my_check_in_at: m.my_check_in_at ?? null,
    status: m.status,
    my_role: mine?.role ?? null,
    my_rsvp: mine?.status ?? null,
    check_in_opens_at: new Date(start - CHECK_IN_OPENS_BEFORE_MS).toISOString(),
    check_in_closes_at: new Date(start + CHECK_IN_CLOSES_AFTER_MS).toISOString(),
  };
}

/** Meetups list: not cancelled, and not ones you declined. */
export function meetupsFromCampus(list: CampusMeetup[] | null | undefined, meId: string | null): T.Meetup[] {
  return (list ?? []).filter((m) => m.status !== 'cancelled' && !(meId && m.participants?.some((p) => p.user_id === meId && p.status === 'declined'))).map((m) => meetupFromCampus(m, meId));
}

/** Social's config with campus-service's realtime URL and territory / Open to Meet flags (Social's when campus is unreachable). */
export function mergeConfig(social: T.AppConfig, campus: CampusConfig | null): T.AppConfig {
  if (!campus) return social;
  return {
    ...social,
    features: {
      ...social.features,
      defend: campus.features?.defend ?? social.features.defend,
      open_to_meet: campus.features?.open_to_meet ?? social.features.open_to_meet,
    },
    realtime_url: campus.realtime_url ?? social.realtime_url,
  };
}

/** Social's stats with campus-service's zone counts (Social's when campus is unreachable). */
export function mergeStats(social: T.LaunchStats, campus: CampusStats | null): T.LaunchStats {
  if (!campus) return social;
  return { ...social, zones_total: campus.zones_total ?? social.zones_total, zones_claimed: campus.zones_claimed ?? social.zones_claimed };
}

/**
 * The hybrid: the Social adapter, with the map-world methods served by campus-service. Built with
 * Object.create, never a spread copy — the "off" API is a Proxy with no own keys (see gateEndpoints).
 */
export function makeHybridCampusApi(social: T.CampusApi, campus: CampusServicePart): T.CampusApi {
  const out = Object.create(social) as T.CampusApi;
  const own = out as unknown as Record<string, unknown>;
  for (const key of CAMPUS_SERVICE_METHODS) own[key] = campus[key];
  out.config = async () => {
    const [s, c] = await Promise.all([social.config(), campus.rawConfig().catch(() => null)]);
    return mergeConfig(s, c);
  };
  out.stats = async () => {
    const [s, c] = await Promise.all([social.stats(), campus.rawStats().catch(() => null)]);
    return mergeStats(s, c);
  };
  // Open to Meet lives on campus-service now, so the profile's switch reads it from there.
  const withOpenToMeet = async (me: Promise<T.Me>): Promise<T.Me> => {
    const [m, open] = await Promise.all([me, campus.openToMeet().catch(() => null)]);
    return open == null ? m : { ...m, open_to_meet: open };
  };
  out.me = () => withOpenToMeet(social.me());
  out.updateMe = (patch) => withOpenToMeet(social.updateMe(patch));
  return out;
}


// ---------------------------------------------------------------------------
// GPS upload: honour campus-service's ingest rules (campus-service/src/activities/gps.ts)
// ---------------------------------------------------------------------------

/**
 * campus-service rejects a WHOLE upload (422 invalid_gps) for one fix it can't accept: an
 * "impossible jump" (> 30 m/s between consecutive points), a point outside the campus area, or
 * timestamps going backwards. The run recorder keeps some fixes like that (it measures speed against
 * a held reference, not the previous fix), so one noisy fix — or a run that leaves campus — would lose
 * the zone check for the whole run. Before uploading, drop exactly those fixes; keep everything else.
 * The server's checks are its anti-cheat and are not relaxed.
 */
export const CAMPUS_MAX_POINTS = 20_000;
const SAFE_SPEED_MS = 25; // the server's hard limit is 30 m/s
const SAFE_EDGE_M = 50; // stay this far inside the announced radius
const MAX_ACCURACY_M = 100;

export type IngestArea = { center: [number, number]; maxRadiusM: number } | null;

export function ingestAreaOf(c: CampusConfig | null | undefined): IngestArea {
  const center = c?.campus?.center;
  const r = c?.campus?.max_radius_m;
  return Array.isArray(center) && center.length === 2 && typeof r === 'number' && r > SAFE_EDGE_M ? { center: [center[0], center[1]], maxRadiusM: r } : null;
}

const distanceM = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const rad = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * rad) / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLng - aLng) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};

/** The points campus-service will accept, in order, and how many were dropped. */
export function pointsForCampus(points: readonly T.ActivityPoint[], area: IngestArea): { points: T.ActivityPoint[]; dropped: number } {
  const kept: T.ActivityPoint[] = [];
  let lastT = -Infinity;
  for (const p of points) {
    const t = Date.parse(p.recorded_at);
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !Number.isFinite(t) || !(p.accuracy_m <= MAX_ACCURACY_M)) continue;
    if (area && distanceM(area.center[0], area.center[1], p.lat, p.lng) > area.maxRadiusM - SAFE_EDGE_M) continue;
    if (t <= lastT) continue;
    const prev = kept[kept.length - 1];
    if (prev && distanceM(prev.lat, prev.lng, p.lat, p.lng) / ((t - lastT) / 1000) > SAFE_SPEED_MS) continue;
    kept.push(p);
    lastT = t;
  }
  let out = kept;
  if (out.length > CAMPUS_MAX_POINTS) {
    // Evenly thin a very long recording, always keeping the last fix.
    const step = out.length / CAMPUS_MAX_POINTS;
    out = Array.from({ length: CAMPUS_MAX_POINTS - 1 }, (_, i) => kept[Math.floor(i * step)]!).concat(kept[kept.length - 1]!);
  }
  return { points: out, dropped: points.length - out.length };
}

/**
 * Why EXPO_PUBLIC_CAMPUS_SERVICE_URL is set but not used (null when it's used or not set). The hybrid
 * needs the Social service as the campus source: a dedicated EXPO_PUBLIC_CAMPUS_API_URL serves the
 * whole contract itself, and the dev mock replaces every backend.
 */
export function campusServiceIgnoredReason(s: { serviceConfigured: boolean; source: 'live' | 'mock' | 'off'; onSocial: boolean; dedicatedCampusApi: boolean }): string | null {
  if (!s.serviceConfigured) return null;
  if (s.source === 'mock') return 'the dev mock is on (EXPO_PUBLIC_DEV_MOCKS=1, or a dev build with no backend URL)';
  if (s.dedicatedCampusApi) return 'EXPO_PUBLIC_CAMPUS_API_URL is set: that dedicated campus backend serves the whole campus contract';
  if (!s.onSocial || s.source !== 'live') return 'EXPO_PUBLIC_SOCIAL_API_URL is not set: campus-service only runs alongside the Social service';
  return null;
}
