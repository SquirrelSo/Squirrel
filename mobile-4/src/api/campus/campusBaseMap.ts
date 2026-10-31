/**
 * IISER Kolkata (Mohanpur) base map — the campus layer the Map draws when the campus backend
 * can't provide its own (GET /v1/zones + GET /v1/map/features not live / not configured).
 *
 * The real map comes from OpenStreetMap: `node scripts/campus-osm.mjs --fetch` (or `--in map.osm`)
 * writes campusOsm.json, and when it has zones this file uses it as is (geometry_source 'osm').
 *
 * Until then: APPROXIMATE hand-placed outlines around the campus centre, drawn as placeholders. The
 * hostels carry their real names, and Nivedita and NSCB Halls sit where OpenStreetMap has them;
 * everything else is a stand-in. It is map data only — places, roads, buildings — with NO people,
 * owners, scores or activity. Territory state and everyone on the map come only from the backend.
 */
import osm from '@/api/campus/campusOsm.json';
import { PLACEHOLDER_GEOMETRY } from '@/api/campus/campusShapes';
import type { BuildingKind, LatLng, MapFeatures, Poi, Zone, ZoneKind } from '@/api/campus/types';

/** campusOsm.json as written by scripts/campus-osm.mjs (empty until the campus is imported). */
type OsmCampus = { source: string | null; zones: Omit<Zone, 'geometry_source'>[]; features: MapFeatures | null };
const OSM = osm as unknown as OsmCampus;
const HAS_OSM = OSM.source === 'osm' && OSM.zones.length > 0 && !!OSM.features;

/** The IISER Kolkata campus centre. */
export const CAMPUS_CENTER: LatLng = [22.9637, 88.5245];
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((CAMPUS_CENTER[0] * Math.PI) / 180);

/** Local metres (x east, y north) → [lat, lng]. */
export const toLatLng = (x: number, y: number): LatLng => [CAMPUS_CENTER[0] + y / M_PER_DEG_LAT, CAMPUS_CENTER[1] + x / M_PER_DEG_LNG];

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const oval = (cx: number, cy: number, rx: number, ry: number, n = 16): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as [number, number];
  });

type Def = { id: string; name: string; short: string | null; kind: ZoneKind; hostel: string | null; xy: [number, number][] };

// The three halls of residence. Nivedita (22.96385, 88.52052 in OpenStreetMap) and NSCB, 200 m east of
// it, are placed from OpenStreetMap; Vidyasagar's spot isn't known yet, so it sits by the lecture
// halls (the institute describes it as the hall closest to them).
const DEFS: Def[] = [
  { id: 'nivedita', name: 'Nivedita Hall', short: 'Nivedita', kind: 'hostel', hostel: 'Nivedita', xy: rect(-470, -35, -345, 70) },
  { id: 'nscb', name: 'Netaji Subhas Chandra Bose Hall', short: 'NSCB', kind: 'hostel', hostel: 'NSCB', xy: rect(-265, -35, -172, 70) },
  { id: 'vidyasagar', name: 'Ishwar Chandra Vidyasagar Hall', short: 'Vidyasagar', kind: 'hostel', hostel: 'Vidyasagar', xy: rect(-130, 195, 0, 270) },
  { id: 'mess', name: 'Mess', short: null, kind: 'food', hostel: null, xy: rect(70, 195, 210, 270) },
  { id: 'cc1', name: 'CC1', short: null, kind: 'academic', hostel: null, xy: rect(70, 40, 195, 150) },
  { id: 'library', name: 'Library', short: null, kind: 'library', hostel: null, xy: rect(225, 55, 335, 165) },
  { id: 'lhc', name: 'Lecture Hall Complex', short: 'LHC', kind: 'academic', hostel: null, xy: rect(-130, 20, 35, 145) },
  { id: 'sports', name: 'Sports Ground Loop', short: 'Sports Loop', kind: 'sports', hostel: null, xy: oval(-380, 230, 110, 70) },
  { id: 'admin', name: 'Admin Lawn', short: 'Admin', kind: 'landmark', hostel: null, xy: rect(-70, -125, 150, -25) },
  { id: 'gate', name: 'Main Gate Boulevard', short: 'Main Gate', kind: 'landmark', hostel: null, xy: rect(-25, -330, 45, -150) },
  { id: 'lake', name: 'Lake Walk', short: null, kind: 'landmark', hostel: null, xy: [[380, -30], [470, -10], [520, -90], [480, -170], [390, -160], [350, -95]] },
];

const centroid = (xy: [number, number][]): [number, number] => [xy.reduce((s, p) => s + p[0], 0) / xy.length, xy.reduce((s, p) => s + p[1], 0) / xy.length];

/**
 * The named zones (geometry only — ownership comes from the backend). Unsurveyed, so they carry
 * campus-service's placeholder marker and the map draws them as approximate.
 */
const PLACEHOLDER_ZONES: Zone[] = DEFS.map((d) => {
  const [cx, cy] = centroid(d.xy);
  return { id: d.id, name: d.name, short_name: d.short, kind: d.kind, hostel: d.hostel, polygon: d.xy.map(([x, y]) => toLatLng(x, y)), centroid: toLatLng(cx, cy), geometry_source: PLACEHOLDER_GEOMETRY };
});

const ll = (pts: [number, number][]) => pts.map(([x, y]) => toLatLng(x, y));

type B = { id: string; xy: [number, number][]; kind: BuildingKind; levels: number; label?: string };
const box = (id: string, x0: number, y0: number, x1: number, y1: number, kind: BuildingKind, levels: number, label?: string): B => ({ id, xy: rect(x0, y0, x1, y1), kind, levels, label });

/** Buildings by use (tints the roof) and height in floors (how tall it's drawn). Approximate. */
const BUILDINGS: B[] = [
  // Halls of residence — wings around a courtyard (inside each hall's zone)
  box('b-niv-1', -460, -25, -415, 20, 'hostel', 5), box('b-niv-2', -400, -25, -355, 20, 'hostel', 5), box('b-niv-3', -460, 30, -355, 60, 'hostel', 5),
  box('b-nscb-1', -258, -25, -222, 20, 'hostel', 5), box('b-nscb-2', -214, -25, -180, 20, 'hostel', 5), box('b-nscb-3', -258, 30, -180, 60, 'hostel', 5),
  box('b-icvh-1', -122, 203, -70, 262, 'hostel', 5), box('b-icvh-2', -60, 203, -8, 262, 'hostel', 5),
  // Core
  box('b-mess', 85, 205, 195, 260, 'food', 2),
  box('b-cc1', 85, 55, 180, 135, 'academic', 3),
  box('b-cc1-wing', 85, 140, 130, 165, 'academic', 2),
  box('b-library', 240, 70, 320, 150, 'academic', 3),
  box('b-lhc', -115, 35, 20, 130, 'academic', 3),
  box('b-lhc-annex', -150, 140, -95, 170, 'academic', 2),
  box('b-admin', -40, -110, 120, -60, 'service', 3),
  box('b-gatehouse', -5, -290, 25, -270, 'service', 1),
  box('b-kiosk', 45, -225, 70, -200, 'food', 1),
  // Research blocks (east and south-east)
  box('b-research-1', 400, 40, 470, 120, 'academic', 4, 'Research blocks'),
  box('b-research-2', 200, -265, 290, -205, 'academic', 4),
  box('b-research-3', 310, -265, 400, -205, 'academic', 4),
  box('b-workshop', 420, -265, 470, -215, 'service', 1),
  // Health centre + guest house (south-west)
  box('b-health', -150, -265, -90, -220, 'service', 2, 'Health centre'),
  box('b-guest', -260, -125, -195, -60, 'residential', 3, 'Guest house'),
  // Sports pavilion by the ground
  box('b-pavilion', -300, 115, -250, 145, 'sports', 2),
  // Faculty housing (west woods): rows of small houses
  ...[0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => box(`b-fac-${r}-${c}`, -545 + c * 62, 345 + r * 50, -505 + c * 62, 375 + r * 50, 'residential', 2, r === 0 && c === 0 ? 'Faculty housing' : undefined))),
];

/** Roads, paths, buildings, green space and landmarks (no descriptions: those would be invented).
 * Place icons sit beside zone names, not on them. */
const PLACEHOLDER_FEATURES: MapFeatures = {
  terrain: [
    { id: 't-central-green', kind: 'green', polygon: ll([[-150, -110], [-80, -140], [200, -140], [230, -40], [200, 10], [-150, 0]]) },
    { id: 't-hostel-green', kind: 'green', polygon: ll([[-100, 440], [420, 440], [420, 470], [-100, 470]]) },
    { id: 't-north-woods', kind: 'woods', polygon: ll([[-120, 475], [440, 470], [470, 520], [-110, 525]]) },
    { id: 't-west-woods', kind: 'woods', polygon: ll([[-575, 315], [-275, 315], [-250, 500], [-575, 505]]) },
    { id: 't-sw-woods', kind: 'woods', polygon: ll([[-575, -360], [-290, -360], [-270, -160], [-330, -140], [-575, -150]]) },
    { id: 't-east-woods', kind: 'woods', polygon: ll([[480, 10], [545, 20], [545, -200], [505, -190], [525, -95]]) },
    { id: 't-gate-lawn-w', kind: 'green', polygon: ll([[-140, -330], [-35, -330], [-35, -165], [-140, -175]]) },
    { id: 't-gate-lawn-e', kind: 'green', polygon: ll([[55, -330], [170, -330], [170, -170], [55, -165]]) },
    // Sports ground: running track with a football pitch inside, courts beside it
    { id: 't-track', kind: 'track', polygon: ll(oval(-380, 230, 100, 62, 40)) },
    { id: 't-sports-field', kind: 'field', polygon: ll(oval(-380, 230, 80, 44, 40)), label: 'Football ground' },
    { id: 't-courts', kind: 'court', polygon: ll(rect(-255, 200, -195, 255)), label: 'Courts' },
    { id: 't-courts-2', kind: 'court', polygon: ll(rect(-255, 262, -215, 300)) },
    // Plazas and parking
    { id: 't-admin-plaza', kind: 'plaza', polygon: ll(rect(-40, -145, 120, -115)) },
    { id: 't-lhc-plaza', kind: 'plaza', polygon: ll(rect(-115, 5, 20, 30)) },
    { id: 't-library-plaza', kind: 'plaza', polygon: ll(rect(225, 155, 335, 178)) },
    { id: 't-gate-parking', kind: 'parking', polygon: ll(rect(55, -300, 140, -245)), label: 'Parking' },
    { id: 't-research-parking', kind: 'parking', polygon: ll(rect(200, -320, 290, -285)) },
    { id: 't-lake', kind: 'water', polygon: ll([[395, -45], [455, -30], [495, -90], [465, -150], [400, -140], [372, -95]]) },
  ],
  roads: [
    { id: 'r-spine', kind: 'road', points: ll([[10, -360], [10, -150], [10, 190], [10, 480]]) },
    { id: 'r-ring', kind: 'road', points: ll([[-160, -150], [360, -150], [360, 185], [-160, 185], [-160, -150]]) },
    { id: 'r-hostels', kind: 'road', points: ll([[-160, 285], [420, 270], [490, 270]]) },
    { id: 'r-west', kind: 'road', points: ll([[-160, 0], [-172, 0]]) },
    { id: 'r-east', kind: 'road', points: ll([[360, -95], [370, -95]]) },
    { id: 'r-north-west', kind: 'road', points: ll([[-160, 185], [-160, 285], [-280, 330], [-570, 330]]) },
    { id: 'r-research', kind: 'road', points: ll([[360, -150], [360, -230], [190, -230], [190, -330]]) },
    { id: 'r-south-west', kind: 'road', points: ll([[-160, -150], [-160, -240], [-80, -240]]) },
    { id: 'r-guest', kind: 'road', points: ll([[-160, -90], [-195, -90]]) },
    { id: 'r-east-link', kind: 'road', points: ll([[360, 185], [440, 185], [440, 130]]) },
    { id: 'p-lawn-1', kind: 'path', points: ll([[-60, -130], [140, -10]]) },
    { id: 'p-lawn-2', kind: 'path', points: ll([[150, -130], [-60, -10]]) },
    { id: 'p-lake-loop', kind: 'path', points: ll([[380, -30], [470, -10], [520, -90], [480, -170], [390, -160], [350, -95], [380, -30]]) },
    { id: 'p-mess', kind: 'path', points: ll([[140, 185], [140, 195]]) },
    { id: 'p-library', kind: 'path', points: ll([[280, 165], [280, 185]]) },
    { id: 'p-hostel-lawn', kind: 'path', points: ll([[-60, 445], [420, 445]]) },
    { id: 'p-sports-hostels', kind: 'path', points: ll([[-300, 140], [-200, 230], [-160, 260]]) },
    { id: 'p-gate-w', kind: 'path', points: ll([[-35, -300], [-120, -300], [-120, -190]]) },
    { id: 'p-gate-e', kind: 'path', points: ll([[55, -190], [160, -190], [160, -150]]) },
    { id: 'p-woods', kind: 'path', points: ll([[-275, 330], [-300, 400], [-380, 450], [-520, 455]]) },
    { id: 'p-library-lake', kind: 'path', points: ll([[335, 110], [380, 60], [400, -20]]) },
  ],
  buildings: BUILDINGS.map((b) => ({ id: b.id, polygon: ll(b.xy), kind: b.kind, levels: b.levels, label: b.label ?? null })),
  pois: [
    { id: 'poi-mess', name: 'Mess', kind: 'food', position: toLatLng(192, 212), zone_id: 'mess', description: null },
    { id: 'poi-canteen', name: 'CC Canteen', kind: 'food', position: toLatLng(205, 95), zone_id: null, description: null },
    { id: 'poi-track', name: 'Running Track', kind: 'sports', position: toLatLng(-472, 230), zone_id: 'sports', description: null },
    { id: 'poi-reading', name: 'Reading Room', kind: 'study', position: toLatLng(312, 80), zone_id: 'library', description: null },
    { id: 'poi-chai', name: 'Gate Chai Tapri', kind: 'hangout', position: toLatLng(88, -212), zone_id: null, description: null },
    { id: 'poi-gate', name: 'Main Gate', kind: 'gate', position: toLatLng(10, -320), zone_id: 'gate', description: null },
    { id: 'poi-amphi', name: 'Amphitheatre', kind: 'hangout', position: toLatLng(-215, 160), zone_id: null, description: null },
  ] satisfies Poi[],
};

/** The named zones and the drawn map: OpenStreetMap's once imported, else the placeholder. */
export const IISER_ZONES: Zone[] = HAS_OSM ? OSM.zones.map((z) => ({ ...z, geometry_source: (z as { source?: string }).source ?? 'osm' })) : PLACEHOLDER_ZONES;
export const IISER_FEATURES: MapFeatures = HAS_OSM ? (OSM.features as MapFeatures) : PLACEHOLDER_FEATURES;

/**
 * The drawn campus under a backend's zones. campus-service serves zone outlines only (no roads,
 * buildings or terrain), which left its map as outlines on bare ground; when the zones are this
 * campus, the OpenStreetMap base drawn here goes underneath — the same real campus, map data
 * only (no people, owners or activity). A backend that draws its own base, another campus, or the
 * hand-placed placeholder (not real geometry) never gets it.
 */
export function withCampusBase(features: MapFeatures | null | undefined, zones: Zone[]): MapFeatures | null {
  const hasBase = !!features && (features.roads.length > 0 || features.buildings.length > 0 || features.terrain.length > 0);
  if (hasBase || !HAS_OSM || !zones.length) return features ?? null;
  const lat = zones.reduce((s, z) => s + z.centroid[0], 0) / zones.length;
  const lng = zones.reduce((s, z) => s + z.centroid[1], 0) / zones.length;
  const far = Math.hypot((lat - CAMPUS_CENTER[0]) * M_PER_DEG_LAT, (lng - CAMPUS_CENTER[1]) * M_PER_DEG_LNG) > 3000;
  if (far) return features ?? null;
  return { ...IISER_FEATURES, pois: features?.pois.length ? features.pois : IISER_FEATURES.pois, zones: features?.zones };
}
