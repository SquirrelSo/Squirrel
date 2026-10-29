/**
 * src/geometry/pipeline.ts
 *
 * Composed geometry pipeline entry point (RM-2.6).
 *
 * Composes all Phase 2 geometry stages in order:
 *   1. snapClose      (RM-2.3)
 *   2. simplifyTrack  (RM-2.2)
 *   3. polygonizeTrack (RM-2.4)
 *   4. validateGeometry (RM-2.5)
 *
 * This file contains NO new geometry logic — it is thin composition only.
 * RM-3.2 calls processTrack and stores the resulting WKT and metadata.
 *
 * DETERMINISM GUARANTEE
 *   Every stage in this pipeline is deterministic:
 *   - snapClose: pure arithmetic on fixed inputs.
 *   - simplifyTrack: Douglas–Peucker, deterministic by construction.
 *   - polygonizeTrack: coordinates serialized to toFixed(6) (projected) and
 *     toFixed(8) (WGS84); faces sorted by area-desc then WKT-lex.
 *   - computeUnionWkt: ST_Union on the projected faces — deterministic because
 *     the face ordering is deterministic (area-desc then WKT-lex sort).
 *   - validateGeometry: PostGIS ST_Area / ST_Perimeter on the same WKT.
 *
 *   No Date.now(), Math.random(), or UUID generation occurs in this file.
 *   Object key iteration order is never relied upon.
 *
 * VALIDATION INPUT
 *   validateGeometry expects a projected WKT (AEQD metres) and returns
 *   metric area and perimeter from PostGIS.
 *
 *   polygonizeTrack returns per-face WKTs in EPSG:4326.  Multiple faces from
 *   a figure-eight share an edge — assembling them into a raw MULTIPOLYGON
 *   produces an OGC-invalid geometry (adjacent polygons must share at most a
 *   point).  The correct input for validation is therefore the ST_Union of all
 *   projected faces, which merges shared edges and yields a valid geometry
 *   on which ST_Area and ST_Perimeter are meaningful.
 *
 *   Pipeline steps:
 *     a. Re-project each 4326 face polygon back to AEQD (same projection
 *        used by polygonizeTrack, centred on the simplified track).
 *     b. Compute ST_Union of all projected faces in the DB to get a valid
 *        unified geometry.
 *     c. Pass that to validateGeometry.
 */

import { snapClose } from "./snap-close.js";
import { simplifyTrack } from "./simplify.js";
import { polygonizeTrack } from "./polygonize.js";
import { validateGeometry } from "./validate.js";
import { createLocalProjection } from "./projection.js";
import { SIMPLIFY_EPSILON_M } from "./constants.js";
import type { LatLng } from "./types.js";
import type { ValidationReason } from "./validate.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type PipelineResult =
  | {
      ok: true;
      /** MULTIPOLYGON WKT in EPSG:4326 — ready for territories.geom. */
      multiPolygonWkt4326: string;
      /** Total territory area in projected square metres (union area). */
      areaM2: number;
      /** Total outer perimeter of the territory in projected metres. */
      perimeterM: number;
      /** true if ST_MakeValid was applied to repair self-intersections. */
      repaired: boolean;
      /** Number of polygon faces in the territory. */
      faceCount: number;
    }
  | {
      ok: false;
      reason: ValidationReason;
      detail: string;
    };

// ── Helper: re-project a single POLYGON WKT from 4326 → AEQD ─────────────────

/**
 * Convert a single POLYGON WKT (EPSG:4326, lng lat order) to a POLYGON WKT
 * in the local AEQD projected CRS (metres).
 *
 * Uses the same innermost-parenthesis regex technique as polygonize.ts to
 * avoid duplicating a full WKT parser, applied in the inverse direction
 * (4326 → AEQD instead of AEQD → 4326).
 */
function reprojectFaceToAeqd(
  polygonWkt4326: string,
  proj: ReturnType<typeof createLocalProjection>
): string {
  const ringRegex = /\(([^()]+)\)/g;
  const projectedRings: string[] = [];
  let m: RegExpExecArray | null;

  // eslint-disable-next-line no-cond-assign
  while ((m = ringRegex.exec(polygonWkt4326)) !== null) {
    const coordPairs = m[1]!.trim().split(",").map((pair) => {
      const parts = pair.trim().split(/\s+/);
      const lng = parseFloat(parts[0] ?? "0");
      const lat = parseFloat(parts[1] ?? "0");
      const p = proj.toPlanar({ lat, lng });
      return `${p.x.toFixed(6)} ${p.y.toFixed(6)}`;
    });
    projectedRings.push(`(${coordPairs.join(", ")})`);
  }

  return `POLYGON(${projectedRings.join(", ")})`;
}

/**
 * Unproject a POLYGON or MULTIPOLYGON WKT from local AEQD (metres)
 * back to EPSG:4326.
 */
export function unprojectAeqdTo4326(
  wktAeqd: string,
  proj: ReturnType<typeof createLocalProjection>
): string {
  // Matches coordinate pairs like "-12.34 56.78"
  const coordPairRegex = /(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  return wktAeqd.replace(coordPairRegex, (match: string, p1: string, p2: string) => {
    const x = parseFloat(p1);
    const y = parseFloat(p2);
    const ll = proj.toLatLng({ x, y });
    return `${ll.lng.toFixed(8)} ${ll.lat.toFixed(8)}`;
  });
}

/**
 * Compute ST_Union of all projected face polygons in a single DB query.
 * Returns the union as a WKT string (POLYGON or MULTIPOLYGON) suitable for
 * passing to validateGeometry.
 *
 * Using ST_Union (rather than assembling a raw MULTIPOLYGON) ensures that
 * faces that share an edge (e.g. the two lobes of a figure-eight) are merged
 * into a valid OGC geometry before validation.
 */
async function computeUnionWkt(
  faceWkts4326: readonly string[],
  anchorPoints: readonly LatLng[]
): Promise<string> {
  const proj = createLocalProjection(anchorPoints);
  const aeqdWkts = faceWkts4326.map((wkt) => reprojectFaceToAeqd(wkt, proj));

  // Build a VALUES list so the union runs in a single round-trip.
  // Each projected polygon WKT is passed as a separate parameter to avoid
  // SQL injection — we never concatenate untrusted input.
  const { pool } = await import("../db/pool.js");

  // Parameterised VALUES query: ($1), ($2), ...
  const placeholders = aeqdWkts
    .map((_, i) => `(ST_GeomFromText($${i + 1}))`)
    .join(", ");

  const sql = `
    SELECT ST_AsText(ST_Union(g)) AS union_wkt
    FROM (VALUES ${placeholders}) AS t(g)
  `;

  const result = await pool.query<{ union_wkt: string }>(sql, aeqdWkts);
  return result.rows[0]?.union_wkt ?? "";
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Process a raw GPS track through the full geometry pipeline.
 *
 * @param points - Raw WGS84 track coordinates.
 * @returns PipelineResult — ok=true with territory geometry, or ok=false with
 *          a machine-readable reason code.
 */
export async function processTrack(
  points: readonly LatLng[]
): Promise<PipelineResult> {
  // ── Stage 1: snap-close ────────────────────────────────────────────────────
  const closed = snapClose(points);
  if (!closed.closed) {
    return {
      ok: false,
      reason: "not_closed",
      detail: `Track gap ${closed.gapM.toFixed(2)} m exceeds the ${closed.reason} threshold.`,
    };
  }

  // ── Stage 2: simplify ──────────────────────────────────────────────────────
  const simplified = simplifyTrack(closed.points, SIMPLIFY_EPSILON_M);

  // ── Stage 3: polygonize ────────────────────────────────────────────────────
  const polyResult = await polygonizeTrack(simplified);

  if (!polyResult.ok) {
    return {
      ok: false,
      reason: polyResult.reason,
      detail: `Polygonization failed: ${polyResult.reason}`,
    };
  }

  // ── Stage 4a: compute projected union for validation ───────────────────────
  // Re-project each 4326 face to AEQD and compute their ST_Union so that:
  //   - Shared edges (e.g. figure-eight lobes) are merged before validation.
  //   - ST_Area / ST_Perimeter return metric values in projected metres.
  const faceWkts4326 = polyResult.faces.map((f) => f.wkt4326);
  const unionWktAeqd = await computeUnionWkt(faceWkts4326, simplified);

  if (!unionWktAeqd) {
    return {
      ok: false,
      reason: "no_faces",
      detail: "ST_Union of projected faces returned empty result.",
    };
  }

  // ── Stage 4b: validate ─────────────────────────────────────────────────────
  const validation = await validateGeometry(unionWktAeqd);

  if (!validation.valid) {
    return {
      ok: false,
      reason: validation.reason,
      detail: validation.detail,
    };
  }

  if (validation.repaired) {
    return {
      ok: false,
      reason: "invalid_geometry",
      detail: "ST_Union produced invalid geometry that failed ST_IsValid.",
    };
  }

  // ── Stage 5: Unproject unioned geometry back to 4326 ───────────────────────
  const proj = createLocalProjection(simplified);
  const unionWkt4326 = unprojectAeqdTo4326(unionWktAeqd, proj);

  // ── All stages passed ──────────────────────────────────────────────────────
  return {
    ok: true,
    multiPolygonWkt4326: unionWkt4326,
    areaM2: validation.areaM2,
    perimeterM: validation.perimeterM,
    repaired: false,
    faceCount: polyResult.faces.length,
  };
}
