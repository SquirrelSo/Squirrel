/**
 * DEV SEED — IISER Kolkata (Mohanpur) zones.
 *
 * ⚠️  GEOMETRY IS A DEVELOPMENT PLACEHOLDER. These outlines are hand-placed rectangles / ovals
 * expressed in metres from the campus centre, using the SAME convention as the mobile dev mock
 * (mobile/src/api/campus/mock/geo.ts) so the app and backend agree in development.
 * They are NOT surveyed boundaries. Every zone is stored with geometry_source = 'dev_placeholder'
 * and must be replaced with authoritative polygons before launch — see docs/GEOGRAPHIC_DATA_REQUIRED.md.
 *
 * The real campus comes from OpenStreetMap: `node mobile-4/scripts/campus-osm.mjs --fetch` writes
 * zones.osm.json next to this file, and the seed (run.ts) then uses those zones and halls instead.
 * The hostels below are the institute's three real halls; Nivedita and NSCB are placed from
 * OpenStreetMap, the rest is a stand-in.
 */
import { config } from '../config.js';
// A static import, so the build copies the file into dist/ with the code that reads it.
import osmFile from './zones.osm.json' with { type: 'json' };

type XY = [number, number];
export type ZoneSeed = {
  id: string; name: string; short: string | null; description: string; kind: 'hostel' | 'academic' | 'sports' | 'food' | 'library' | 'landmark';
  zoneType: 'AREA' | 'ROUTE'; hostel: string | null; xy: XY[]; routeXy?: XY[]; threshold?: number;
};

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = () => 111_320 * Math.cos((config.campus.centerLat * Math.PI) / 180);
/** Local metres (x east, y north) → [lng, lat] for WKT. */
export const toLngLat = ([x, y]: XY): [number, number] => [config.campus.centerLng + x / mPerDegLng(), config.campus.centerLat + y / M_PER_DEG_LAT];

const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const oval = (cx: number, cy: number, rx: number, ry: number, n = 16): XY[] => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as XY; });

export const HOSTELS = [
  { id: 'nivedita', name: 'Nivedita Hall', short: 'Nivedita' },
  { id: 'nscb', name: 'Netaji Subhas Chandra Bose Hall', short: 'NSCB' },
  { id: 'vidyasagar', name: 'Ishwar Chandra Vidyasagar Hall', short: 'Vidyasagar' },
];

export const ZONES: ZoneSeed[] = [
  // Same ids/placement as the mobile dev mock
  { id: 'nivedita', name: 'Nivedita Hall', short: 'Nivedita', kind: 'hostel', zoneType: 'AREA', hostel: 'nivedita', xy: rect(-470, -35, -345, 70), description: 'Nivedita Hall and its courtyard.' },
  { id: 'nscb', name: 'Netaji Subhas Chandra Bose Hall', short: 'NSCB', kind: 'hostel', zoneType: 'AREA', hostel: 'nscb', xy: rect(-265, -35, -172, 70), description: 'NSCB Hall and its courtyard.' },
  { id: 'vidyasagar', name: 'Ishwar Chandra Vidyasagar Hall', short: 'Vidyasagar', kind: 'hostel', zoneType: 'AREA', hostel: 'vidyasagar', xy: rect(-130, 195, 0, 270), description: 'Vidyasagar Hall, by the lecture halls.' },
  { id: 'mess', name: 'Mess', short: null, kind: 'food', zoneType: 'AREA', hostel: null, xy: rect(70, 195, 210, 270), description: 'Central mess and the post-run chai spot.' },
  { id: 'cc1', name: 'CC1', short: null, kind: 'academic', zoneType: 'AREA', hostel: null, xy: rect(70, 40, 195, 150), description: 'Classroom Complex 1.' },
  { id: 'library', name: 'Library', short: null, kind: 'library', zoneType: 'AREA', hostel: null, xy: rect(225, 55, 335, 165), description: 'Central library and reading room.' },
  { id: 'lhc', name: 'Lecture Hall Complex', short: 'LHC', kind: 'academic', zoneType: 'AREA', hostel: null, xy: rect(-130, 20, 35, 145), description: 'Lecture Hall Complex.' },
  { id: 'sports', name: 'Sports Ground Loop', short: 'Sports Loop', kind: 'sports', zoneType: 'ROUTE', hostel: null, xy: oval(-380, 230, 125, 85), routeXy: oval(-380, 230, 110, 70, 24), threshold: 0.8, description: 'The 400 m track around the sports ground. Complete the loop to qualify.' },
  { id: 'admin', name: 'Admin Lawn', short: 'Admin', kind: 'landmark', zoneType: 'AREA', hostel: null, xy: rect(-70, -125, 150, -25), description: 'Lawn in front of the administrative building.' },
  { id: 'gate', name: 'Main Gate Boulevard', short: 'Main Gate', kind: 'landmark', zoneType: 'AREA', hostel: null, xy: rect(-25, -330, 45, -150), description: 'The boulevard from the main gate.' },
  { id: 'lake', name: 'Lake Walk', short: null, kind: 'landmark', zoneType: 'ROUTE', hostel: null, xy: [[350, -20], [480, 0], [540, -90], [495, -185], [385, -175], [335, -100]], routeXy: [[380, -30], [470, -10], [520, -90], [480, -170], [390, -160], [350, -95], [380, -30]], threshold: 0.75, description: 'The path around the campus lake. Walk the loop to qualify.' },
  // Additional zones so development has ~15
  { id: 'research', name: 'Research Complex', short: 'Research', kind: 'academic', zoneType: 'AREA', hostel: null, xy: rect(380, 30, 520, 150), description: 'Research and laboratory complex.' },
  { id: 'amphi', name: 'Amphitheatre', short: 'Amphi', kind: 'landmark', zoneType: 'AREA', hostel: null, xy: oval(-215, 160, 45, 35), threshold: 0.5, description: 'Open-air amphitheatre.' },
  { id: 'health', name: 'Health Centre', short: 'Health', kind: 'landmark', zoneType: 'AREA', hostel: null, xy: rect(-160, -280, -80, -205), description: 'Campus health centre.' },
];

export const polygonWkt = (xy: XY[]) => { const ring = [...xy, xy[0]!].map(toLngLat).map(([lng, lat]) => `${lng} ${lat}`).join(','); return `POLYGON((${ring}))`; };
export const lineWkt = (xy: XY[]) => `LINESTRING(${xy.map(toLngLat).map(([lng, lat]) => `${lng} ${lat}`).join(',')})`;

/** zones.osm.json as written by mobile-4/scripts/campus-osm.mjs; empty until the campus is imported. */
export type OsmZone = {
  id: string; name: string; short_name: string | null; kind: ZoneSeed['kind']; hostel: string | null; polygon: [number, number][];
  /** ROUTE zones (the sports loop, the lake) carry the closed loop to complete and their threshold. */
  zone_type?: 'AREA' | 'ROUTE'; route?: [number, number][] | null; threshold?: number | null;
  /** 'traced': a loop recorded with the app, for a zone OpenStreetMap lacks (the sports track). */
  source?: 'traced';
};
export function loadOsmZones(data: unknown = osmFile): OsmZone[] {
  const d = data as { source?: string | null; zones?: OsmZone[] };
  return d.source === 'osm' && Array.isArray(d.zones) ? d.zones : [];
}
/** A route of [lat, lng] as a WKT line (lng first). */
export const osmLineWkt = (pts: [number, number][]) => `LINESTRING(${pts.map(([lat, lng]) => `${lng} ${lat}`).join(',')})`;
/**
 * How far a ROUTE zone's outline reaches beyond its loop. A zone is only checked when the track
 * enters it, and people walk beside a lake, not on it: this keeps the path inside the zone and is
 * wider than the route-matching tolerance (ROUTE_MATCH_TOLERANCE_M, 20 m by default).
 */
export const ROUTE_ZONE_PAD_M = 25;
/** An OSM ring of [lat, lng] as WKT (closed, lng first). */
export const osmPolygonWkt = (ring: [number, number][]) => `POLYGON((${[...ring, ring[0]!].map(([lat, lng]) => `${lng} ${lat}`).join(',')}))`;
