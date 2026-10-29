#!/usr/bin/env node
/**
 * Build the IISER Kolkata campus map from OpenStreetMap, replacing the hand-placed placeholder.
 *
 *   node scripts/campus-osm.mjs --fetch            download from the Overpass API (needs internet)
 *   node scripts/campus-osm.mjs --in map.osm       use a file: openstreetmap.org → Export (.osm XML),
 *                                                  or a saved Overpass JSON response
 *   node scripts/campus-osm.mjs --trace lap.json [--id sports] [--name "Sports Ground Loop"]
 *                                                  save a loop recorded with the app as a traced route
 *                                                  (lap.json: GET /v1/activities/:id from campus-service)
 *
 * Writes the same data to two places:
 *   mobile-4/src/api/campus/campusOsm.json          the app's base map (api/campus/campusBaseMap.ts)
 *   campus-service/src/seed/zones.osm.json          the backend seed (seed/zones.ts, seed/run.ts)
 *
 * What becomes what:
 *   - the campus is the university outline (OSM way 354549537); everything is kept only when its
 *     centre lies inside it
 *   - every named area of 800 m² or more becomes a zone (hostels, library, grounds, lake…), its kind
 *     read from the OSM tags; well-known places keep the ids the rest of the system already uses
 *   - the sports loop (or any running track) and the lake are ROUTE zones: you qualify by going
 *     round them. The lake's route is the footpath around it when OSM has one, else its shore
 *   - all buildings, roads/paths, green/water/sports areas and named points become the drawn map
 *   - a running track (leisure=track) becomes the sports loop whether OSM draws it as an area or a
 *     line, named or not. If OSM has none, a traced route from scripts/campus-routes.json is used
 *     instead (geometry_source 'traced'); OSM wins whenever it has the zone
 *   - known spelling mistakes in OSM names are corrected (NAME_FIXES)
 * Nothing is invented: a place missing from OpenStreetMap is missing here too.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAMPUS_WAY_ID = 354549537;
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const MIN_ZONE_M2 = 800;

/** Spelling mistakes in OpenStreetMap's names, corrected on import until they're fixed upstream. */
export const NAME_FIXES = [[/\bFacultty\b/g, 'Faculty']];
const fixName = (name) => NAME_FIXES.reduce((n, [re, to]) => n.replace(re, to), name);

// --- parsing ------------------------------------------------------------------------------------

const unescapeXml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, unescapeXml(v)]));

/** OSM XML (the openstreetmap.org Export button) → { nodes, ways, relations }. */
export function parseOsmXml(xml) {
  const nodes = new Map();
  const ways = new Map();
  const relations = new Map();
  const re = /<(node|way|relation)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  for (const [, type, head, , body = ''] of xml.matchAll(re)) {
    const a = attrs(head);
    if (a.visible === 'false') continue;
    const tags = Object.fromEntries([...body.matchAll(/<tag\b([^>]*)\/>/g)].map(([, t]) => attrs(t)).map((t) => [t.k, t.v]));
    const id = Number(a.id);
    if (type === 'node') nodes.set(id, { lat: Number(a.lat), lon: Number(a.lon), tags });
    else if (type === 'way') ways.set(id, { nodes: [...body.matchAll(/<nd\b[^>]*ref="(-?\d+)"/g)].map(([, r]) => Number(r)), tags });
    else relations.set(id, { members: [...body.matchAll(/<member\b([^>]*)\/>/g)].map(([, m]) => attrs(m)).map((m) => ({ type: m.type, ref: Number(m.ref), role: m.role ?? '' })), tags });
  }
  return { nodes, ways, relations };
}

/** An Overpass JSON response (`out body; >; out skel qt;`) → { nodes, ways, relations }. */
export function parseOverpassJson(json) {
  const nodes = new Map();
  const ways = new Map();
  const relations = new Map();
  for (const e of json.elements ?? []) {
    if (e.type === 'node') nodes.set(e.id, { lat: e.lat, lon: e.lon, tags: e.tags ?? {} });
    else if (e.type === 'way') ways.set(e.id, { nodes: e.nodes ?? [], tags: e.tags ?? {} });
    else if (e.type === 'relation') relations.set(e.id, { members: e.members ?? [], tags: e.tags ?? {} });
  }
  return { nodes, ways, relations };
}

// --- geometry -------------------------------------------------------------------------------------

const round = (n) => Math.round(n * 1e6) / 1e6;
const M_PER_DEG = 111_320;

/** Local metres around a reference latitude, for areas and distances. */
const metres = (lat0) => ([lat, lng]) => [lng * M_PER_DEG * Math.cos((lat0 * Math.PI) / 180), lat * M_PER_DEG];

function areaM2(ring) {
  if (ring.length < 3) return 0;
  const toM = metres(ring[0][0]);
  const p = ring.map(toM);
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** Distance in metres between two [lat, lng] points (equirectangular; fine at campus scale). */
export function distanceM(a, b) {
  const toM = metres((a[0] + b[0]) / 2);
  const [x1, y1] = toM(a);
  const [x2, y2] = toM(b);
  return Math.hypot(x2 - x1, y2 - y1);
}
const pathLengthM = (pts) => pts.slice(1).reduce((s, p, i) => s + distanceM(pts[i], p), 0);

/** Area-weighted centroid of a ring of [lat, lng] (falls back to the vertex mean for slivers). */
export function centroid(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [y1, x1] = ring[i];
    const [y2, x2] = ring[(i + 1) % ring.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-14) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cy / (3 * a), cx / (3 * a)];
}

export function insideRing([lat, lng], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas–Peucker in metres; keeps zones within the backend's 5–30 vertex guidance. */
function simplify(ring, toleranceM) {
  if (ring.length <= 4) return ring;
  const toM = metres(ring[0][0]);
  const p = ring.map(toM);
  const keep = new Array(ring.length).fill(false);
  keep[0] = keep[ring.length - 1] = true;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = p[s];
    const [x2, y2] = p[e];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
    let best = -1;
    let at = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((x2 - x1) * (y1 - p[i][1]) - (x1 - p[i][0]) * (y2 - y1)) / len;
      if (d > best) [best, at] = [d, i];
    }
    if (best > toleranceM) {
      keep[at] = true;
      stack.push([s, at], [at, e]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

function zoneRing(ring) {
  let tol = 1;
  let out = simplify(ring, tol);
  while (out.length > 30 && tol < 40) out = simplify(ring, (tol *= 1.6));
  return out;
}

/** A way's coordinates as [lat, lng], without the repeated closing point; null if a node is missing. */
function wayCoords(osm, way) {
  const pts = [];
  for (const ref of way.nodes) {
    const n = osm.nodes.get(ref);
    if (!n) return null;
    pts.push([round(n.lat), round(n.lon)]);
  }
  return pts;
}
const isClosed = (way) => way.nodes.length >= 4 && way.nodes[0] === way.nodes[way.nodes.length - 1];
const open = (pts) => pts.slice(0, -1);

/** The outer ring of a multipolygon relation, joining its outer ways end to end. */
function relationOuter(osm, rel) {
  const parts = rel.members.filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '')).map((m) => osm.ways.get(m.ref)).filter(Boolean).map((w) => wayCoords(osm, w)).filter(Boolean);
  if (!parts.length) return null;
  const key = (p) => `${p[0]},${p[1]}`;
  const rings = [];
  let pool = parts.map((p) => [...p]);
  while (pool.length) {
    let ring = pool.shift();
    let grew = true;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const q = pool[i];
        const end = key(ring[ring.length - 1]);
        if (key(q[0]) === end) ring = ring.concat(q.slice(1));
        else if (key(q[q.length - 1]) === end) ring = ring.concat([...q].reverse().slice(1));
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(open(ring));
  }
  return rings.sort((a, b) => areaM2(b) - areaM2(a))[0] ?? null;
}

// --- classification -------------------------------------------------------------------------------

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 48);

/** Ids the rest of the system already uses (Social zones, XP engine, deep links) for well-known places. */
const KNOWN_IDS = [
  [/nivedita/i, 'nivedita'],
  [/subhas|\bnscb\b/i, 'nscb'],
  [/vidyasagar/i, 'vidyasagar'],
  [/\b(running )?track\b|sports ground/i, 'sports'],
  [/\blibrary\b/i, 'library'],
  [/lecture hall/i, 'lhc'],
  [/\b(main )?gate\b/i, 'gate'],
  [/\b(mess|dining)\b/i, 'mess'],
  [/\blake\b/i, 'lake'],
  [/\badmin/i, 'admin'],
];

function zoneKind(tags, name) {
  const b = tags.building ?? '';
  if (tags.amenity === 'library' || /\blibrary\b/i.test(name)) return 'library';
  if (['dormitory', 'hostel'].includes(b) || tags.tourism === 'hostel' || /\b(hall|hostel)\b/i.test(name) && !/lecture|auditor|dining/i.test(name)) return 'hostel';
  if (['restaurant', 'cafe', 'fast_food', 'food_court', 'canteen'].includes(tags.amenity) || /\b(mess|canteen|cafeteria|dining)\b/i.test(name)) return 'food';
  if (tags.leisure && ['pitch', 'track', 'sports_centre', 'stadium', 'swimming_pool', 'fitness_centre'].includes(tags.leisure)) return 'sports';
  if (['house', 'residential', 'apartments', 'detached', 'terrace'].includes(b) || /quarters|housing|residen/i.test(name)) return 'landmark';
  if (['university', 'college', 'school'].includes(b) || /lecture|lab|research|department|complex|block|centre|center/i.test(name)) return 'academic';
  return 'landmark';
}

function buildingKind(tags) {
  const b = tags.building ?? '';
  const name = tags.name ?? '';
  if (['dormitory', 'hostel'].includes(b) || /\b(hall|hostel)\b/i.test(name) && !/lecture|auditor|dining/i.test(name)) return 'hostel';
  if (['house', 'residential', 'apartments', 'detached', 'terrace'].includes(b)) return 'residential';
  if (/\b(mess|canteen|cafeteria|dining)\b/i.test(name) || ['restaurant', 'cafe', 'fast_food', 'canteen'].includes(tags.amenity)) return 'food';
  if (tags.leisure === 'sports_centre' || b === 'sports_hall' || b === 'stadium') return 'sports';
  if (['university', 'college', 'school'].includes(b) || tags.amenity === 'library') return 'academic';
  return 'service';
}

function terrainKind(tags) {
  if (tags.natural === 'water' || tags.water || tags.leisure === 'swimming_pool' || tags.landuse === 'reservoir' || tags.landuse === 'basin') return 'water';
  if (tags.leisure === 'track') return 'track';
  if (tags.leisure === 'pitch') return ['basketball', 'tennis', 'volleyball', 'badminton'].includes(tags.sport) ? 'court' : 'field';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'woods';
  if (tags.amenity === 'parking') return 'parking';
  if (tags.place === 'square' || tags.highway === 'pedestrian' || tags.area === 'yes' && tags.highway) return 'plaza';
  if (['grass', 'meadow', 'recreation_ground', 'village_green', 'orchard'].includes(tags.landuse) || ['park', 'garden'].includes(tags.leisure) || ['grassland', 'scrub'].includes(tags.natural)) return 'green';
  return null;
}

const ROADS = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street', 'road']);
const PATHS = new Set(['footway', 'path', 'pedestrian', 'track', 'cycleway', 'steps', 'bridleway']);

function poiKind(tags) {
  if (['restaurant', 'cafe', 'fast_food', 'food_court', 'canteen'].includes(tags.amenity) || tags.shop) return 'food';
  if (tags.leisure || tags.sport) return 'sports';
  if (['library', 'university', 'college'].includes(tags.amenity)) return 'study';
  if (tags.barrier === 'gate' || tags.entrance) return 'gate';
  return 'hangout';
}

// --- assembly -------------------------------------------------------------------------------------

/** Everything on campus, in the app's MapFeatures shape plus zones. */
export function buildCampusGeo(osm, { campusWayId = CAMPUS_WAY_ID, tracedRoutes = [] } = {}) {
  const campusWay = osm.ways.get(campusWayId);
  const campusRing = campusWay ? wayCoords(osm, campusWay) : null;
  if (!campusRing) throw new Error(`The campus outline (OSM way ${campusWayId}) isn't in the data. Export an area that covers the whole campus.`);
  const boundary = open(campusRing);
  const onCampus = (pt) => insideRing(pt, boundary);
  for (const els of [osm.nodes, osm.ways, osm.relations]) {
    for (const el of els.values()) if (el.tags?.name) el.tags = { ...el.tags, name: fixName(el.tags.name) };
  }

  const areas = [];
  for (const [id, way] of osm.ways) {
    if (id === campusWayId || !isClosed(way)) continue;
    // A closed road or footpath is a loop, not an area (unless tagged area=yes, like a plaza).
    if (way.tags.highway && way.tags.area !== 'yes') continue;
    const pts = wayCoords(osm, way);
    if (pts) areas.push({ osmId: `w${id}`, tags: way.tags, ring: open(pts) });
  }
  for (const [id, rel] of osm.relations) {
    if (rel.tags.type !== 'multipolygon') continue;
    const ring = relationOuter(osm, rel);
    if (ring) areas.push({ osmId: `r${id}`, tags: rel.tags, ring });
  }
  const campusAreas = areas.filter((a) => a.ring.length >= 3 && onCampus(centroid(a.ring)));

  const buildings = [];
  const terrain = [];
  const zones = [];
  const used = new Set();
  const uniqueId = (base) => {
    let id = base || 'zone';
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  // Closed paths and roads, for the walk around the lake.
  const loopPaths = [];
  for (const way of osm.ways.values()) {
    const h = way.tags.highway;
    if (!h || !(ROADS.has(h) || PATHS.has(h)) || !isClosed(way)) continue;
    const pts = wayCoords(osm, way);
    if (pts) loopPaths.push(open(pts));
  }
  /** ROUTE zones: the loop to complete, closed, or null for an AREA zone. */
  const routeFor = (a, id) => {
    if (a.tags.leisure !== 'track' && id !== 'sports' && id !== 'lake') return null;
    let ring = a.ring;
    if (id === 'lake' || terrainKind(a.tags) === 'water') {
      const c = centroid(a.ring);
      const area = areaM2(a.ring);
      const around = loopPaths.filter((r) => insideRing(c, r) && areaM2(r) >= area && areaM2(r) <= 4 * area).sort((x, y) => areaM2(x) - areaM2(y))[0];
      if (around) ring = around;
    }
    const line = simplify(ring, 2);
    return { route: [...line, line[0]], threshold: id === 'lake' ? 0.75 : 0.8 };
  };

  // Named areas → zones, biggest first so a well-known id goes to the main feature.
  for (const a of [...campusAreas].sort((x, y) => areaM2(y.ring) - areaM2(x.ring))) {
    const name = a.tags.name?.trim();
    if (!name || areaM2(a.ring) < MIN_ZONE_M2) continue;
    const known = KNOWN_IDS.find(([re, id]) => re.test(name) && !used.has(id));
    const kind = zoneKind(a.tags, name);
    const id = uniqueId(known ? known[1] : slug(name));
    const ring = zoneRing(a.ring);
    const route = routeFor(a, id);
    zones.push({
      id,
      name,
      short_name: a.tags.short_name ?? (name.length > 18 ? name.replace(/\b(Hall|Complex|Building|Ground)\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 18) : null),
      kind,
      hostel: kind === 'hostel' ? id : null,
      polygon: ring,
      centroid: centroid(ring).map(round),
      zone_type: route ? 'ROUTE' : 'AREA',
      route: route?.route ?? null,
      threshold: route?.threshold ?? null,
      osm_id: a.osmId,
    });
  }

  // The running track. OSM draws it either as a closed area or as a line (often unnamed); either
  // way the longest one on campus becomes the sports loop unless a named area already did.
  const tracks = [];
  for (const [wid, way] of osm.ways) {
    if (way.tags.leisure !== 'track') continue;
    const pts = wayCoords(osm, way);
    if (!pts || pts.length < 3 || !onCampus(pts[Math.floor(pts.length / 2)])) continue;
    const loop = isClosed(way) || distanceM(pts[0], pts[pts.length - 1]) <= 30;
    tracks.push({ osmId: `w${wid}`, tags: way.tags, pts: isClosed(way) ? open(pts) : pts, loop, length: pathLengthM(pts) });
  }
  const bestTrack = tracks.filter((t) => t.loop).sort((a, b) => b.length - a.length)[0];
  let sportsLoop = zones.find((z) => z.zone_type === 'ROUTE' && z.kind === 'sports');
  if (!sportsLoop && bestTrack) {
    const line = simplify(bestTrack.pts, 2);
    const ring = zoneRing(bestTrack.pts);
    sportsLoop = {
      id: uniqueId(used.has('sports') ? 'running-track' : 'sports'),
      name: bestTrack.tags.name?.trim() || 'Running Track',
      short_name: null, kind: 'sports', hostel: null, polygon: ring, centroid: centroid(ring).map(round),
      zone_type: 'ROUTE', route: [...line, line[0]], threshold: 0.8, osm_id: bestTrack.osmId,
    };
    zones.push(sportsLoop);
    if (!isClosed(osm.ways.get(Number(bestTrack.osmId.slice(1))))) terrain.push({ id: `t-${bestTrack.osmId}`, kind: 'track', polygon: bestTrack.pts, label: sportsLoop.name });
  }

  // Traced routes fill in what OSM lacks (OSM wins whenever it has the zone).
  const traced = [];
  for (const r of tracedRoutes) {
    if (zones.some((z) => z.id === r.id) || (r.id === 'sports' && sportsLoop)) continue;
    const ring = open(r.route);
    const zring = zoneRing(ring);
    used.add(r.id);
    zones.push({
      id: r.id, name: r.name, short_name: r.short_name ?? null, kind: r.kind ?? 'sports', hostel: null,
      polygon: zring, centroid: centroid(zring).map(round), zone_type: 'ROUTE', route: r.route,
      threshold: r.threshold ?? 0.8, source: 'traced', osm_id: null,
    });
    terrain.push({ id: `t-traced-${r.id}`, kind: 'track', polygon: ring, label: r.name });
    traced.push(r.id);
  }

  for (const a of campusAreas) {
    if (a.tags.building && a.tags.building !== 'no') {
      const levels = Number.parseInt(a.tags['building:levels'] ?? '', 10);
      buildings.push({ id: `b-${a.osmId}`, polygon: a.ring, kind: buildingKind(a.tags), levels: Number.isFinite(levels) ? levels : null, label: a.tags.name ?? null });
      continue;
    }
    const kind = terrainKind(a.tags);
    if (kind) terrain.push({ id: `t-${a.osmId}`, kind, polygon: a.ring, label: a.tags.name ?? null });
  }

  const roads = [];
  for (const [id, way] of osm.ways) {
    const h = way.tags.highway;
    if (!h || way.tags.area === 'yes' || !(ROADS.has(h) || PATHS.has(h))) continue;
    const pts = wayCoords(osm, way);
    if (!pts || pts.length < 2) continue;
    // Keep the parts of the line that are on campus (with the points either side, so roads reach the edge).
    let run = [];
    const flush = () => {
      if (run.length >= 2) roads.push({ id: `r-w${id}${roads.some((r) => r.id === `r-w${id}`) ? `-${roads.length}` : ''}`, kind: ROADS.has(h) ? 'road' : 'path', points: run });
      run = [];
    };
    pts.forEach((p, i) => {
      const near = onCampus(p) || (i > 0 && onCampus(pts[i - 1])) || (i < pts.length - 1 && onCampus(pts[i + 1]));
      if (near) run.push(p);
      else flush();
    });
    flush();
  }

  const zoneAt = (pt) => zones.find((z) => insideRing(pt, z.polygon))?.id ?? null;
  const pois = [];
  for (const [id, n] of osm.nodes) {
    const name = n.tags.name?.trim();
    if (!name) continue;
    const pt = [round(n.lat), round(n.lon)];
    if (!onCampus(pt)) continue;
    pois.push({ id: `poi-n${id}`, name, kind: poiKind(n.tags), position: pt, zone_id: zoneAt(pt), description: null });
  }

  const sortById = (xs) => xs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    source: 'osm',
    attribution: '© OpenStreetMap contributors (ODbL)',
    campus_way: campusWayId,
    center: centroid(boundary).map(round),
    boundary,
    zones: sortById(zones),
    /** What the importer found for the sports loop, for the command's report. */
    report: {
      track_in_osm: tracks.map((t) => ({ osm_id: t.osmId, shape: t.loop ? 'loop' : 'open line', length_m: Math.round(t.length) })),
      sports_loop: sportsLoop ? { id: sportsLoop.id, source: 'osm', osm_id: sportsLoop.osm_id } : traced.includes('sports') ? { id: 'sports', source: 'traced' } : null,
      traced,
    },
    features: { terrain: sortById(terrain), roads: sortById(roads), buildings: sortById(buildings), pois: sortById(pois) },
  };
}

// --- traced routes ----------------------------------------------------------------------------------

/**
 * A loop recorded with the app → a closed route of [lat, lng]. Takes campus-service's
 * GET /v1/activities/:id response (its `track`), or any GeoJSON LineString / Feature / FeatureCollection.
 * The lap has to end near where it started; points are simplified to 2 m.
 */
export function routeFromGeoJson(json) {
  const geom = json?.track ?? json?.geometry ?? json?.features?.find((f) => f?.geometry?.type === 'LineString')?.geometry ?? json;
  if (geom?.type !== 'LineString' || !Array.isArray(geom.coordinates)) throw new Error('No recorded line found: pass the activity JSON from GET /v1/activities/:id, or a GeoJSON LineString.');
  const pts = [];
  for (const [lng, lat] of geom.coordinates) {
    const p = [round(lat), round(lng)];
    if (!pts.length || distanceM(pts[pts.length - 1], p) > 0.5) pts.push(p);
  }
  if (pts.length < 10) throw new Error('That recording is too short to be a lap.');
  const gap = distanceM(pts[0], pts[pts.length - 1]);
  if (gap > 40) throw new Error(`The recording ends ${Math.round(gap)} m from where it started. Record exactly one full lap, finishing where you began.`);
  const ring = simplify(gap < 0.5 ? pts.slice(0, -1) : pts, 2);
  return { route: [...ring, ring[0]], length_m: Math.round(pathLengthM([...ring, ring[0]])) };
}

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES_FILE = join(here, 'campus-routes.json');
const readRoutes = () => {
  try {
    return JSON.parse(readFileSync(ROUTES_FILE, 'utf8')).routes ?? [];
  } catch {
    return [];
  }
};

// --- command line ---------------------------------------------------------------------------------

const QUERY = `[out:json][timeout:60];
way(${CAMPUS_WAY_ID});
map_to_area->.campus;
(
  way(${CAMPUS_WAY_ID});
  nwr(area.campus);
  way(around.campus:30)[highway];
);
out body;
>;
out skel qt;`;

async function main(argv) {
  const at = (flag) => argv[argv.indexOf(flag) + 1];
  if (argv.includes('--trace')) {
    const { route, length_m } = routeFromGeoJson(JSON.parse(readFileSync(at('--trace'), 'utf8')));
    const id = argv.includes('--id') ? at('--id') : 'sports';
    const entry = {
      id,
      name: argv.includes('--name') ? at('--name') : id === 'sports' ? 'Sports Ground Loop' : id,
      kind: 'sports',
      threshold: argv.includes('--threshold') ? Number(at('--threshold')) : 0.8,
      length_m,
      traced_at: new Date().toISOString(),
      route,
    };
    const routes = [...readRoutes().filter((r) => r.id !== id), entry];
    writeFileSync(ROUTES_FILE, `${JSON.stringify({ note: 'Loops recorded with the app, used for zones OpenStreetMap lacks. Add with --trace.', routes }, null, 1)}\n`);
    console.log(`Saved "${entry.name}" (${id}): ${length_m} m, ${route.length - 1} points → ${ROUTES_FILE}`);
    console.log('Now re-run the import (--fetch or --in) to put it on the map.');
    return;
  }
  let osm;
  if (argv.includes('--fetch')) {
    console.log('Downloading the campus from OpenStreetMap (Overpass)…');
    const res = await fetch(OVERPASS_URL, { method: 'POST', body: new URLSearchParams({ data: QUERY }), headers: { 'User-Agent': 'squirrel-social-campus-import' } });
    if (!res.ok) throw new Error(`Overpass answered ${res.status}. Try again in a minute, or use --in with an exported file.`);
    osm = parseOverpassJson(await res.json());
  } else if (argv.includes('--in')) {
    const file = at('--in');
    const text = readFileSync(file, 'utf8');
    osm = text.trimStart().startsWith('{') ? parseOverpassJson(JSON.parse(text)) : parseOsmXml(text);
  } else {
    console.log('Usage: node scripts/campus-osm.mjs --fetch | --in <map.osm | overpass.json>');
    process.exit(2);
  }
  const { report, ...geo } = { ...buildCampusGeo(osm, { tracedRoutes: readRoutes() }), fetched_at: new Date().toISOString() };
  const targets = [join(here, '..', 'src', 'api', 'campus', 'campusOsm.json'), join(here, '..', '..', 'campus-service', 'src', 'seed', 'zones.osm.json')];
  for (const t of targets) writeFileSync(t, `${JSON.stringify(geo, null, 1)}\n`);
  const f = geo.features;
  console.log(`${geo.zones.length} zones, ${f.buildings.length} buildings, ${f.roads.length} roads/paths, ${f.terrain.length} areas, ${f.pois.length} places.`);
  for (const z of geo.zones) console.log(`  ${z.kind.padEnd(9)} ${z.zone_type.padEnd(6)} ${z.id.padEnd(28)} ${z.name}${z.source === 'traced' ? '  (traced)' : ''}`);
  console.log(
    report.track_in_osm.length
      ? `Running track in OpenStreetMap: ${report.track_in_osm.map((t) => `${t.osm_id} (${t.shape}, ${t.length_m} m)`).join(', ')}`
      : 'Running track in OpenStreetMap: none.',
  );
  console.log(
    report.sports_loop
      ? `Sports loop: ${report.sports_loop.id}, from ${report.sports_loop.source === 'osm' ? `OpenStreetMap (${report.sports_loop.osm_id})` : 'the traced route in scripts/campus-routes.json'}.`
      : 'Sports loop: none. Add the track on openstreetmap.org (leisure=track), or record one lap with the app and run --trace.',
  );
  console.log(`Wrote:\n  ${targets.join('\n  ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
