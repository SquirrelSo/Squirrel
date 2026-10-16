/**
 * src/geometry/polygonize.ts
 *
 * Converts a closed GPS track into valid polygon faces using PostGIS planar-
 * graph face extraction (ST_Node + ST_Polygonize).
 *
 * Pipeline (in order):
 *   1. snapClose — reject open tracks before any DB work.
 *   2. simplifyTrack at SIMPLIFY_EPSILON_M — reduce point count.
 *   3. Project to local AEQD planar metres.
 *   4. Build LINESTRING WKT in the projected CRS.
 *   5. Run the parameterised polygonize query (db/queries/polygonize.sql).
 *   6. If zero faces returned, signal no_faces.
 *   7. Unproject each face polygon back to EPSG:4326.
 *   8. Sort faces by area descending, then WKT string (deterministic order).
 *   9. Assemble a MULTIPOLYGON WKT in EPSG:4326.
 *
 * WHY NOT BUILD THE POLYGON DIRECTLY FROM THE POINT LIST:
 *   A figure-eight track would produce a self-intersecting ring (invalid).
 *   An out-and-back track would produce a zero-area sliver.
 *   ST_Node splits the linework at all self-intersections FIRST, then
 *   ST_Polygonize extracts the correct enclosed faces.
 *
 * SECURITY: the PostGIS query is parameterised ($1). The projected LINESTRING
 * WKT is passed as a query parameter, never concatenated into SQL.
 *
 * DATABASE SKIP: this module uses a lazy pool import so the file can be
 * imported in unit test files without DATABASE_URL being set.  Tests that
 * actually need the database check for DATABASE_URL and skip if absent.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { snapClose } from "./snap-close.js";
import { simplifyTrack } from "./simplify.js";
import { createLocalProjection } from "./projection.js";
import { SIMPLIFY_EPSILON_M } from "./constants.js";
import type { LatLng } from "./types.js";

// ── SQL ───────────────────────────────────────────────────────────────────────

// Load the SQL file at module initialisation time.
// Path: project-root/db/queries/polygonize.sql
// __dirname equivalent for ESM:
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const POLYGONIZE_SQL = readFileSync(
  join(__dirname, "../../../db/queries/polygonize.sql"),
  "utf8"
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FaceInfo {
  /** WKT of this face polygon in EPSG:4326. */
  wkt4326: string;
  /** Area of this face in projected square metres (from PostGIS ST_Area). */
  areaM2: number;
}

export type PolygonizeResult =
  | {
      ok: true;
      faces: FaceInfo[];
      /** MULTIPOLYGON WKT in EPSG:4326, contains all faces. */
      multiPolygonWkt4326: string;
      /** Sum of all face areas in projected square metres. */
      totalAreaM2: number;
    }
  | {
      ok: false;
      reason: "not_closed" | "no_faces";
      faces: [];
    };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a WKT LINESTRING from an array of planar (x, y) pairs.
 * The ring must be closed (first ≡ last) before this is called.
 */
function buildLinestringWkt(
  pts: ReadonlyArray<{ x: number; y: number }>
): string {
  const coordStr = pts
    .map((p) => `${p.x.toFixed(6)} ${p.y.toFixed(6)}`)
    .join(", ");
  return `LINESTRING(${coordStr})`;
}

/**
 * Parse a WKT POLYGON in the projected CRS and convert every coordinate
 * to EPSG:4326, returning a WKT POLYGON string.
 *
 * Only handles POLYGON (not MULTIPOLYGON or GEOMETRYCOLLECTION) because
 * ST_Polygonize returns individual face polygons.
 */
function reprojectPolygonWkt(
  wkt: string,
  proj: ReturnType<typeof createLocalProjection>
): string {
  // Extract ring coordinate strings: POLYGON((x y, x y, ...)[, (inner), ...])
  const ringRegex = /\(([^()]+)\)/g;
  const rings: string[] = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = ringRegex.exec(wkt)) !== null) {
    const coordPairs = m[1]!.trim().split(",").map((pair) => {
      const parts = pair.trim().split(/\s+/);
      const x = parseFloat(parts[0] ?? "0");
      const y = parseFloat(parts[1] ?? "0");
      const ll = proj.toLatLng({ x, y });
      return `${ll.lng.toFixed(8)} ${ll.lat.toFixed(8)}`;
    });
    rings.push(`(${coordPairs.join(", ")})`);
  }
  return `POLYGON(${rings.join(", ")})`;
}

/**
 * Assemble a WKT MULTIPOLYGON from individual POLYGON WKT strings.
 */
function buildMultiPolygonWkt(polygonWkts: string[]): string {
  // Strip the "POLYGON" prefix from each to get just the ring group
  const bodies = polygonWkts.map((w) => w.replace(/^POLYGON/, "").trim());
  return `MULTIPOLYGON(${bodies.join(", ")})`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert a GPS track into polygon faces via PostGIS ST_Node + ST_Polygonize.
 *
 * @param points - WGS84 track (open or closed). The function handles
 *                 snap-closing internally.
 * @returns PolygonizeResult — ok=true with faces, or ok=false with reason.
 */
export async function polygonizeTrack(
  points: readonly LatLng[]
): Promise<PolygonizeResult> {
  // ── Step 1: snap-close ─────────────────────────────────────────────────────
  const closed = snapClose(points);
  if (!closed.closed) {
    return { ok: false, reason: "not_closed", faces: [] };
  }

  // ── Step 2: simplify ───────────────────────────────────────────────────────
  const simplified = simplifyTrack(closed.points, SIMPLIFY_EPSILON_M);

  // ── Step 3: project to local AEQD ─────────────────────────────────────────
  const proj = createLocalProjection(simplified);
  const planar = simplified.map((p) => proj.toPlanar(p));

  // ── Step 4: build LINESTRING WKT in projected CRS ─────────────────────────
  const linestringWkt = buildLinestringWkt(planar);

  // ── Step 5: polygonize query ───────────────────────────────────────────────
  // Lazy-import pool so this file is safe to import without DATABASE_URL.
  const { pool } = await import("../db/pool.js");

  const result = await pool.query<{ face_wkt: string; area_m2: string }>(
    POLYGONIZE_SQL,
    [linestringWkt]
  );

  // ── Step 6: no faces → no_faces ───────────────────────────────────────────
  if (result.rows.length === 0) {
    return { ok: false, reason: "no_faces", faces: [] };
  }

  // ── Step 7: unproject each face back to EPSG:4326 ─────────────────────────
  const faces: FaceInfo[] = result.rows.map((row) => ({
    wkt4326: reprojectPolygonWkt(row.face_wkt, proj),
    areaM2: parseFloat(row.area_m2),
  }));

  // ── Step 8: sort faces — area descending, then WKT string (deterministic) ─
  faces.sort((a, b) => {
    const areaDiff = b.areaM2 - a.areaM2;
    if (areaDiff !== 0) return areaDiff;
    return a.wkt4326.localeCompare(b.wkt4326);
  });

  // ── Step 9: assemble MultiPolygon WKT ─────────────────────────────────────
  const multiPolygonWkt4326 = buildMultiPolygonWkt(faces.map((f) => f.wkt4326));
  const totalAreaM2 = faces.reduce((sum, f) => sum + f.areaM2, 0);

  return {
    ok: true,
    faces,
    multiPolygonWkt4326,
    totalAreaM2,
  };
}
