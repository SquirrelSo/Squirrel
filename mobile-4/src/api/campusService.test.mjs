import assert from 'node:assert/strict';
import test from 'node:test';
import { endpointAvailability, gateEndpoints, isEndpointUnavailable, optedInWith } from './availability.ts';
import {
  activeNowFromCampus,
  CAMPUS_SERVICE_METHODS,
  campusServiceIgnoredReason,
  heatmapFromCampus,
  heatWindowUnavailable,
  HIDDEN_REASON_FALLBACK,
  hiddenActionFor,
  hiddenCodeOf,
  hiddenReasonText,
  ingestAreaOf,
  CAMPUS_MAX_POINTS,
  isPlaceholderZone,
  makeHybridCampusApi,
  mapFeaturesFromCampus,
  mergeConfig,
  meetupFromCampus,
  meetupsFromCampus,
  mergeStats,
  nearbyPlayersFromCampus,
  sharedContextFromCampus,
  pointsForCampus,
  sharedZonesFromCampus,
} from './campus/campusShapes.ts';

const socialConfig = {
  campus: { id: 'iiser-kolkata', name: 'IISER Kolkata', short_name: 'IISER K', email_domains: ['ac.in'], center: [22.96, 88.52], launched_at: null, hostels: ['Tapti'] },
  features: { create_crew: true, create_event: true, defend: false, open_to_meet: false, date_mode: { available: false, reason: 'x', requirements: [] }, meetup_safety_notifications: false },
  realtime_url: null,
};
const socialStats = { users_total: 40, users_active_now: 3, zones_total: 0, zones_claimed: 0, crews_total: 0, founding_spots_left: null, updated_at: 't' };

/** A Social stand-in: every method answers `social:<name>`. */
function fakeSocial() {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'config') return async () => socialConfig;
        if (key === 'stats') return async () => socialStats;
        if (key === 'me' || key === 'updateMe') return async () => ({ user_id: 'u1', display_name: 'Aanya', open_to_meet: false });
        return async () => `social:${String(key)}`;
      },
    },
  );
}
function fakeCampus(overrides = {}) {
  const part = Object.fromEntries(CAMPUS_SERVICE_METHODS.map((m) => [m, async () => `campus:${m}`]));
  return {
    ...part,
    rawConfig: async () => ({ features: { defend: true, open_to_meet: true, create_event: false }, realtime_url: 'wss://campus/v1/realtime' }),
    rawStats: async () => ({ zones_total: 12, zones_claimed: 5, users_total: 999 }),
    openToMeet: async () => true,
    ...overrides,
  };
}

test('hybrid: map-world methods go to campus-service, everything else stays on Social', async () => {
  const api = makeHybridCampusApi(fakeSocial(), fakeCampus());
  for (const m of CAMPUS_SERVICE_METHODS) assert.equal(await api[m](), `campus:${m}`, m);
  for (const m of ['crews', 'events', 'profile', 'invites', 'notifications', 'squirrelBoard', 'searchPeople', 'sendPoke', 'dateSuggestions', 'setBlocked', 'zonePlayers', 'ambassador']) {
    assert.equal(await api[m](), `social:${m}`, m);
  }
});

test('hybrid over the "off" Proxy keeps every method (Object.create, not a spread copy)', async () => {
  const off = new Proxy({}, { get: (_t, key) => () => Promise.reject(new Error(`off:${String(key)}`)) });
  const api = makeHybridCampusApi(off, fakeCampus());
  assert.equal(typeof api.crews, 'function');
  await assert.rejects(api.crews(), /off:crews/);
  assert.equal(await api.zones(), 'campus:zones');
});

test('config: Social config + campus realtime_url, defend and open_to_meet; Social values when campus is down', async () => {
  const cfg = await makeHybridCampusApi(fakeSocial(), fakeCampus()).config();
  assert.equal(cfg.realtime_url, 'wss://campus/v1/realtime');
  assert.equal(cfg.features.defend, true);
  assert.equal(cfg.features.open_to_meet, true);
  assert.equal(cfg.features.create_event, true, 'other flags stay Social’s');
  assert.deepEqual(cfg.campus, socialConfig.campus);
  const down = await makeHybridCampusApi(fakeSocial(), fakeCampus({ rawConfig: async () => Promise.reject(new Error('offline')) })).config();
  assert.deepEqual(down, socialConfig);
  assert.deepEqual(mergeConfig(socialConfig, { features: null }), { ...socialConfig, features: { ...socialConfig.features } });
});

test('stats: only zone counts come from campus-service; Social values when campus is down', async () => {
  const s = await makeHybridCampusApi(fakeSocial(), fakeCampus()).stats();
  assert.deepEqual(s, { ...socialStats, zones_total: 12, zones_claimed: 5 });
  const down = await makeHybridCampusApi(fakeSocial(), fakeCampus({ rawStats: async () => Promise.reject(new Error('503')) })).stats();
  assert.deepEqual(down, socialStats);
  assert.deepEqual(mergeStats(socialStats, null), socialStats);
});

test('me: Social profile with campus-service’s Open to Meet (Social’s when campus is down)', async () => {
  assert.equal((await makeHybridCampusApi(fakeSocial(), fakeCampus()).me()).open_to_meet, true);
  assert.equal((await makeHybridCampusApi(fakeSocial(), fakeCampus()).updateMe({ bio: 'hi' })).open_to_meet, true);
  const down = await makeHybridCampusApi(fakeSocial(), fakeCampus({ openToMeet: async () => Promise.reject(new Error('x')) })).me();
  assert.equal(down.open_to_meet, false);
  assert.equal(down.display_name, 'Aanya');
});

test('sharedZones and heatmap are gated unless campus-service opts them in; the rest stay gated', async () => {
  const service = { sharedZones: async () => ({ people: [] }), heatmap: async () => ({ cells: [] }), saveDetails: async () => ({}) };
  const rules = { sharedZones: { capability: 'sharedZones' }, heatmap: { capability: 'heatmap' }, saveDetails: { capability: 'profileDetails' } };
  const gated = gateEndpoints(service, rules, new Set());
  await assert.rejects(gated.sharedZones(), (e) => isEndpointUnavailable(e));
  await assert.rejects(gated.heatmap('7d'), (e) => isEndpointUnavailable(e));
  const withCampus = gateEndpoints(service, rules, optedInWith(['sharedZones', 'heatmap'], new Set()));
  assert.deepEqual(await withCampus.sharedZones(), { people: [] });
  assert.deepEqual(await withCampus.heatmap('7d'), { cells: [] });
  await assert.rejects(withCampus.saveDetails(), (e) => isEndpointUnavailable(e) && e.capability === 'profileDetails');
  assert.deepEqual([...optedInWith(['heatmap'], new Set(['media']))].sort(), ['heatmap', 'media']);
});

test('map features: GeoJSON zones → MapFeatures (empty base map) with geometry_source kept', () => {
  const raw = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'cc1',
        geometry: { type: 'Polygon', coordinates: [[[88.52, 22.96], [88.53, 22.96], [88.53, 22.97], [88.52, 22.96]]] },
        properties: { id: 'cc1', name: 'CC1', short_name: 'CC1', kind: 'academic', centroid: [22.963, 88.526], hostel: null, geometry_source: 'dev_placeholder', territory: { state: 'UNCLAIMED' } },
      },
      { type: 'Feature', id: 'bad', geometry: null, properties: { id: 'bad', name: 'No shape' } },
    ],
  };
  const f = mapFeaturesFromCampus(raw);
  assert.deepEqual([f.roads, f.buildings, f.terrain, f.pois], [[], [], [], []]);
  assert.equal(f.zones.length, 1);
  const z = f.zones[0];
  assert.deepEqual(z.polygon, [[22.96, 88.52], [22.96, 88.53], [22.97, 88.53]], '[lng,lat] → [lat,lng], closing point dropped');
  assert.deepEqual(z.centroid, [22.963, 88.526]);
  assert.equal(z.geometry_source, 'dev_placeholder');
  assert.ok(isPlaceholderZone(z));
  assert.ok(!isPlaceholderZone({ geometry_source: 'survey' }) && !isPlaceholderZone({}) && !isPlaceholderZone(null));
  const contract = { roads: [{ id: 'r', kind: 'road', points: [] }], buildings: [], terrain: [], pois: [] };
  assert.equal(mapFeaturesFromCampus(contract), contract);
});

test('heatmap: {lat,lng} + low/medium/high → HeatCell; unsupported windows say so', () => {
  const h = heatmapFromCampus({ window: '7d', grid_size_m: 100, suppression_threshold_users: 3, cells: [{ center: { lat: 22.9637, lng: 88.5245 }, intensity: 'medium' }, { center: { lat: 22.96, lng: 88.52 }, intensity: 'high' }] }, '7d', 'now');
  assert.equal(h.available, true);
  assert.equal(h.min_people_per_cell, 3);
  assert.deepEqual(h.cells[0], { id: '22.96370,88.52450', center: [22.9637, 88.5245], radius_m: 75, intensity: 0.66, level: 'active', zone_id: null });
  assert.equal(h.cells[1].level, 'high');
  const no = heatWindowUnavailable('24h', 'now');
  assert.equal(no.available, false);
  assert.equal(no.cells.length, 0);
  assert.match(no.reason, /7 days/);
});

test('shared zones: by zone → by person, most shared first, "often" zone on top', () => {
  const p = (id, name, activity) => ({ user_id: id, display_name: name, avatar_url: null, hostel: null, activity });
  const r = sharedZonesFromCampus({
    zones: [
      { zone: { id: 'cc1', name: 'CC1' }, people: [p('a', 'Aanya', 'sometimes'), p('b', 'Kabir', 'sometimes')] },
      { zone: { id: 'lib', name: 'Library' }, people: [p('a', 'Aanya', 'often')] },
      { zone: { id: 'mine', name: 'Just me' }, people: [] },
    ],
    cap: { zones: 10, people_per_zone: 5 },
  });
  assert.equal(r.visible, true);
  assert.deepEqual(
    r.people.map((x) => [x.person.user_id, x.shared_zones_count, x.top_zone?.zone_id]),
    [['a', 2, 'lib'], ['b', 1, 'cc1']],
  );
  assert.deepEqual(sharedZonesFromCampus({ zones: [] }).people, []);
});

test('active now: campus person → a full PersonCard (no crash on missing shared/activity)', () => {
  const a = activeNowFromCampus({
    active_now: 2,
    active: [{ person: { user_id: 'a', display_name: 'Aanya', avatar_url: null, hostel: 'Tapti', connection_mode: 'friends', bio: null }, activity: { type: 'run', started_at: 't' }, proximity: null }],
    nearby: [],
    as_of: 't',
    visible: false,
    hidden_reason: 'open_to_meet_off',
  });
  const card = a.active[0].person;
  assert.equal(card.activity.top_activity, 'run');
  assert.deepEqual(card.shared, { shared_zones: [], shared_crews: [], shared_events: [], icebreakers: [] });
  assert.equal(card.connection_mode, 'friends');
  assert.equal(a.active_now, 2);
});

test('nearby players: the hidden_reason code becomes text', () => {
  const r = nearbyPlayersFromCampus({ players: [], as_of: 't', visible: false, hidden_reason: 'open_to_meet_off' });
  assert.match(r.hidden_reason, /Open to Meet/);
  assert.equal(nearbyPlayersFromCampus({ players: [], as_of: 't', visible: true, hidden_reason: null }).hidden_reason, null);
});

// ---- GPS upload vs campus-service's ingest check (a single refused fix used to 422 the whole run)

const CENTER = [22.9637, 88.5245];
const AREA = { center: CENTER, maxRadiusM: 4000 };
const T0 = Date.parse('2026-09-30T06:00:00Z');
const fix = (i, lat, lng = CENTER[1], accuracy_m = 8) => ({ lat, lng, recorded_at: new Date(T0 + i * 1000).toISOString(), accuracy_m });
/** A run heading north from the centre at ~2.2 m/s, one fix a second. */
const run = (n) => Array.from({ length: n }, (_, i) => fix(i, CENTER[0] + i * 0.00002));

test('ingest area comes from /v1/config campus.center + max_radius_m, else no area check', () => {
  assert.deepEqual(ingestAreaOf({ campus: { center: CENTER, max_radius_m: 4000 } }), AREA);
  assert.equal(ingestAreaOf({ campus: { center: CENTER } }), null); // older campus-service: server still checks
  assert.equal(ingestAreaOf(null), null);
});

test('a clean run is uploaded untouched', () => {
  const pts = run(60);
  assert.deepEqual(pointsForCampus(pts, AREA), { points: pts, dropped: 0 });
});

test('one noisy fix (37 m in 1 s) is dropped, not the run', () => {
  const pts = run(60);
  pts[30] = { ...pts[30], lat: pts[30].lat + 0.000315 };
  const out = pointsForCampus(pts, AREA);
  assert.equal(out.dropped, 1);
  assert.ok(!out.points.includes(pts[30]));
  // What remains never exceeds the server's 30 m/s between consecutive points.
  for (let i = 1; i < out.points.length; i++) {
    const a = out.points[i - 1], b = out.points[i];
    const d = Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180));
    assert.ok(d / ((Date.parse(b.recorded_at) - Date.parse(a.recorded_at)) / 1000) < 30);
  }
});

test('fixes outside the campus area are dropped; a run that never enters campus leaves nothing', () => {
  const far = CENTER[0] + 5000 / 111_320;
  const pts = [...run(40), ...Array.from({ length: 10 }, (_, i) => fix(1000 + i, far + i * 0.00002))];
  assert.equal(pointsForCampus(pts, AREA).points.length, 40);
  assert.equal(pointsForCampus(pts.slice(40), AREA).points.length, 0);
  // No area known: only the jump rule applies, and 5 km in 1000 s is a plausible pace, so all are kept.
  assert.equal(pointsForCampus(pts, null).points.length, 50);
});

test('out-of-order or duplicate timestamps and inaccurate fixes are dropped', () => {
  const pts = run(10);
  const out = pointsForCampus([...pts.slice(0, 5), pts[3], { ...pts[5], accuracy_m: 150 }, ...pts.slice(6)], AREA);
  assert.deepEqual(out.points, [...pts.slice(0, 5), ...pts.slice(6)]);
});

test('very long recordings are thinned to the server limit, keeping the last fix', () => {
  const pts = Array.from({ length: CAMPUS_MAX_POINTS + 500 }, (_, i) => fix(i, CENTER[0] + i * 0.000001)); // a slow, steady walk
  const out = pointsForCampus(pts, null);
  assert.equal(out.points.length, CAMPUS_MAX_POINTS);
  assert.equal(out.points.at(-1), pts.at(-1));
});

test('EXPO_PUBLIC_CAMPUS_SERVICE_URL is never ignored silently', () => {
  const base = { serviceConfigured: true, source: 'live', onSocial: true, dedicatedCampusApi: false };
  assert.equal(campusServiceIgnoredReason(base), null); // the hybrid: used
  assert.equal(campusServiceIgnoredReason({ ...base, serviceConfigured: false }), null); // not set: nothing to say
  assert.match(campusServiceIgnoredReason({ ...base, onSocial: false, source: 'off' }), /EXPO_PUBLIC_SOCIAL_API_URL/);
  assert.match(campusServiceIgnoredReason({ ...base, onSocial: false, dedicatedCampusApi: true }), /EXPO_PUBLIC_CAMPUS_API_URL/);
  assert.match(campusServiceIgnoredReason({ ...base, source: 'mock' }), /dev mock/);
});

test('ambassador applications are Social’s: never routed to campus-service, and not gated', async () => {
  assert.ok(!CAMPUS_SERVICE_METHODS.includes('ambassador') && !CAMPUS_SERVICE_METHODS.includes('applyAmbassador'));
  let called = false;
  const svc = { ambassador: async () => { called = true; return {}; } };
  const api = gateEndpoints(svc, { ambassador: { capability: 'ambassador' } }, new Set());
  await api.ambassador();
  assert.equal(called, true);
});

// ---- meetups + post-meetup rating (ADR-032: campus-service owns them)

const START = '2026-10-02T12:00:00.000Z';
const person = (user_id, display_name) => ({ user_id, display_name, avatar_url: null, hostel: 'Tapti', open_to_meet: true });
const part = (user_id, name, role, status) => ({ user_id, role, status, responded_at: null, person: person(user_id, name) });
const campusMeetup = (over = {}) => ({
  id: 'm1',
  created_by: 'me',
  zone_id: 'lib',
  zone: { id: 'lib', name: 'Library Lawn' },
  place_text: null,
  starts_at: START,
  status: 'confirmed',
  participants: [part('me', 'Me', 'host', 'accepted'), part('a', 'Aanya', 'guest', 'accepted'), part('r', 'Ravi', 'guest', 'invited'), part('d', 'Dev', 'guest', 'declined')],
  ...over,
});

test('meetups, check-in and rating are routed to campus-service; updateMe is not (ADR-032 open item 1)', async () => {
  for (const m of ['meetups', 'meetup', 'checkIn', 'meetupRating', 'rateMeetup']) assert.ok(CAMPUS_SERVICE_METHODS.includes(m), m);
  assert.ok(!CAMPUS_SERVICE_METHODS.includes('updateMe'));
  const api = makeHybridCampusApi(fakeSocial(), fakeCampus());
  assert.equal(await api.meetups(), 'campus:meetups');
  assert.equal(await api.rateMeetup(), 'campus:rateMeetup');
});

test('meetup: host + invitees → attendees (declined dropped), titled by who else is coming, nobody checked in', () => {
  const m = meetupFromCampus(campusMeetup(), 'me');
  assert.equal(m.title, 'Meetup with Aanya & Ravi');
  assert.deepEqual(m.attendees.map((a) => [a.user_id, a.checked_in]), [['me', false], ['a', false], ['r', false]]);
  assert.equal(m.my_check_in_at, null);
  assert.equal(m.event_id, null);
  assert.deepEqual(m.location, { name: 'Library Lawn', zone_id: 'lib' });
  // check-in window computed in-app: 1 h before → 6 h after the start
  assert.equal(m.check_in_opens_at, '2026-10-02T11:00:00.000Z');
  assert.equal(m.check_in_closes_at, '2026-10-02T18:00:00.000Z');
  // place text when there's no zone; many people collapse to "+N"
  const many = meetupFromCampus(campusMeetup({ zone_id: null, zone: null, place_text: 'Main gate', participants: ['a', 'b', 'c', 'e'].map((u) => part(u, u.toUpperCase(), 'guest', 'accepted')) }), 'me');
  assert.equal(many.title, 'Meetup with A, B +2');
  assert.deepEqual(many.location, { name: 'Main gate', zone_id: null });
  assert.equal(meetupFromCampus(campusMeetup({ participants: [part('me', 'Me', 'host', 'accepted')] }), 'me').title, 'Meetup at Library Lawn');
});

test('meetups list hides cancelled meetups and ones you declined', () => {
  const list = [campusMeetup({ id: 'ok' }), campusMeetup({ id: 'gone', status: 'cancelled' }), campusMeetup({ id: 'declined', participants: [part('me', 'Me', 'guest', 'declined'), part('h', 'Host', 'host', 'accepted')] }), campusMeetup({ id: 'done', status: 'completed' })];
  assert.deepEqual(meetupsFromCampus(list, 'me').map((m) => m.id), ['ok', 'done']);
  assert.deepEqual(meetupsFromCampus(undefined, 'me'), []);
});

test('on campus-service check-in and rating are both served; other sources: rating gated, check-in passes', async () => {
  let called = false;
  let rated = false;
  const svc = { checkIn: async () => { called = true; return {}; }, meetupRating: async () => { rated = true; return {}; } };
  const gates = { checkIn: { capability: 'meetupCheckIn', when: () => true }, meetupRating: { capability: 'meetupRating' } };
  const onService = gateEndpoints(svc, gates, optedInWith(['sharedZones', 'heatmap', 'meetupRating', 'meetupCheckIn'], new Set()));
  await onService.checkIn('m1', false);
  assert.equal(called, true);
  called = false;
  await onService.meetupRating('m1');
  assert.equal(rated, true);
  const noService = gateEndpoints(svc, gates, new Set());
  await assert.rejects(noService.meetupRating('m1'), (e) => isEndpointUnavailable(e) && e.capability === 'meetupRating');
  const elsewhere = gateEndpoints(svc, { checkIn: { capability: 'meetupCheckIn', when: () => false } }, new Set());
  await elsewhere.checkIn('m1', false);
  assert.equal(called, true);
  assert.equal(endpointAvailability('meetupCheckIn', new Set(['meetupCheckIn'])).status, 'available');
});

// ---- hidden_reason codes

test('hidden reasons: known codes → text, both block-list spellings, unknown → generic (never the raw code)', () => {
  assert.match(hiddenReasonText('open_to_meet_off'), /Open to Meet/);
  const blocks = 'Can’t check your block list right now — try again in a moment.';
  assert.equal(hiddenReasonText('blocks_unreachable'), blocks);
  assert.equal(hiddenReasonText('blocks_unavailable'), blocks, 'old spelling still understood');
  assert.equal(hiddenCodeOf('blocks_unavailable'), 'blocks_unreachable');
  assert.equal(hiddenCodeOf('blocks_unreachable'), 'blocks_unreachable');
  // featureUnavailable() reads any code ending in "unavailable" as "not built": the canonical key must not.
  assert.ok(!hiddenCodeOf('blocks_unreachable').endsWith('unavailable'));
  assert.equal(hiddenReasonText('quota_exceeded_v2'), HIDDEN_REASON_FALLBACK);
  assert.ok(!HIDDEN_REASON_FALLBACK.includes('quota_exceeded_v2'));
  assert.equal(hiddenReasonText(null), null);
  assert.equal(hiddenCodeOf(undefined), null);
  assert.equal(hiddenActionFor('open_to_meet_off'), 'settings');
  assert.equal(hiddenActionFor('blocks_unreachable'), 'retry');
  assert.equal(hiddenActionFor('something_new'), 'retry');
  assert.equal(hiddenActionFor('blocked'), null);
  assert.equal(hiddenActionFor(null), null);
});

test('map players: blocks_unreachable keeps visible:true but carries the code and text', () => {
  const r = nearbyPlayersFromCampus({ players: [], as_of: 't', visible: true, hidden_reason: 'blocks_unreachable' });
  assert.equal(r.visible, true);
  assert.equal(r.hidden_code, 'blocks_unreachable');
  assert.match(r.hidden_reason, /block list/);
  assert.equal(nearbyPlayersFromCampus({ players: [], as_of: 't', visible: false, hidden_reason: 'open_to_meet_off' }).hidden_code, 'open_to_meet_off');
  assert.equal(nearbyPlayersFromCampus({ players: [], as_of: 't', visible: true, hidden_reason: null }).hidden_code, null);
});

test('active now and shared zones pass the reason through (an empty list says why)', () => {
  const a = activeNowFromCampus({ active_now: 0, active: [], nearby: [], as_of: 't', visible: true, hidden_reason: 'blocks_unavailable' });
  assert.equal(a.hidden_code, 'blocks_unreachable');
  assert.match(a.hidden_reason, /block list/);
  const off = activeNowFromCampus({ active_now: 3, active: [], nearby: [], as_of: 't', visible: false, hidden_reason: 'open_to_meet_off' });
  assert.equal(off.hidden_code, 'open_to_meet_off');
  assert.equal(activeNowFromCampus({ active_now: 1, active: [], nearby: [], as_of: 't' }).hidden_reason, null);
  const z = sharedZonesFromCampus({ zones: [], hidden_reason: 'blocks_unreachable' });
  assert.deepEqual([z.people, z.visible, z.hidden_code], [[], true, 'blocks_unreachable']);
  assert.match(z.hidden_reason, /block list/);
  const odd = sharedZonesFromCampus({ zones: [], hidden_reason: 'mystery' });
  assert.equal(odd.hidden_reason, HIDDEN_REASON_FALLBACK);
  assert.equal(sharedZonesFromCampus({ zones: [] }).hidden_code, null);
});

test('a person’s context: blocked → just an empty context (nothing reveals the block)', () => {
  const empty = { shared_zones: [], shared_crews: [], shared_events: [], icebreakers: [] };
  assert.deepEqual(sharedContextFromCampus({ ...empty, hidden_reason: 'blocked' }), empty);
  const ctx = { ...empty, shared_zones: [{ zone_id: 'lib', zone_name: 'Library', relation: 'both_ran' }] };
  assert.deepEqual(sharedContextFromCampus({ ...ctx, hidden_reason: null }), ctx);
});

test('a person’s context: blocks couldn’t be checked → empty, but says so (never "no common ground")', () => {
  const empty = { shared_zones: [], shared_crews: [], shared_events: [], icebreakers: [] };
  const c = sharedContextFromCampus({ ...empty, hidden_reason: 'blocks_unreachable' });
  assert.deepEqual([c.shared_zones, c.icebreakers, c.hidden_code], [[], [], 'blocks_unreachable']);
  assert.match(c.hidden_reason, /block list/);
  assert.equal(hiddenActionFor(c.hidden_code), 'retry');
  // Even if a server leaked data alongside the code, none of it is shown.
  const leaky = sharedContextFromCampus({ ...empty, shared_zones: [{ zone_id: 'lib', zone_name: 'Library', relation: 'both_ran' }], hidden_reason: 'blocks_unreachable' });
  assert.deepEqual(leaky.shared_zones, []);
});
