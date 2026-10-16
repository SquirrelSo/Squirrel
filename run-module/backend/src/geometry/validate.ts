/**
 * src/geometry/validate.ts
 *
 * Geometry validation gates (RM-2.5).
 *
 * Each gate is a trust boundary with a machine-readable reason code.
 * The reason code is stored against the run (RM-3.2) and surfaced to the
 * mobile client so the user knows why their run earned no territory.
 *
 * Gate order — first failure wins:
 *   1. ST_IsValid.  If invalid, try ST_MakeValid once.  Accept the repair
 *      only if it yields a valid POLYGON or MULTIPOLYGON.  Anything else
 *      (GeometryCollection, LineString, Point) is treated as unrepairable.
 *   2. Total area < MIN_TERRITORY_AREA_M2 → 'below_minimum_area'
 *   3. Isoperimetric check: area > (P² / 4π) × ISOPERIMETRIC_TOLERANCE
 *      → 'isoperimetric_violation'
 *
 * Rejections NEVER throw — a thrown error means a genuine code/DB failure.
 * A validation rejection is a normal business outcome and must return a
 * typed ValidationResult, not an exception.
 *
 * Database access: lazy pool import so this file is safe to import in
 * unit tests without DATABASE_URL being set.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  MIN_TERRITORY_AREA_M2,
  ISOPERIMETRIC_TOLERANCE,
} from "./constants.js";

// ── SQL ────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VALIDATE_SQL = readFileSync(
  join(__dirname, "../../../db/queries/validate.sql"),
  "utf8"
);

// ── Types ──────────────────────────────────────────────────────────────────────

export type ValidationReason =
  | "invalid_geometry"
  | "below_minimum_area"
  | "isoperimetric_violation"
  | "not_closed"   // passed through from polygonize for the combined pipeline
  | "no_faces";    // passed through from polygonize for the combined pipeline

export type ValidationResult =
  | {
      valid: true;
      /** The geometry WKT that passed validation (may be the repaired version). */
      geometryWkt: string;
      /** Net area in projected square metres (from PostGIS). */
      areaM2: number;
      /** Perimeter in projected metres (from PostGIS). */
      perimeterM: number;
      /** true if ST_MakeValid was applied; false if the input was already valid. */
      repaired: boolean;
    }
  | {
      valid: false;
      reason: ValidationReason;
      /** Human-readable detail for logging and the mobile client. */
      detail: string;
    };

// ── DB row type ───────────────────────────────────────────────────────────────

interface ValidateRow {
  is_valid: boolean;
  invalid_reason: string;
  area_m2: string;       // pg returns numeric as string
  perimeter_m: string;
  make_valid_wkt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true for WKT types that are usable polygon geometry. */
function isPolygonalWkt(wkt: string): boolean {
  const upper = wkt.trimStart().toUpperCase();
  return upper.startsWith("POLYGON") || upper.startsWith("MULTIPOLYGON");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a polygon WKT (in projected AEQD metres) against all RM-2.5 gates.
 *
 * @param wktProjected - WKT of a POLYGON or MULTIPOLYGON in a local projected CRS.
 *                       Must be in the same projected CRS used by polygonize.ts
 *                       (AEQD, SRID 0).
 * @returns ValidationResult — valid=true with geometry details, or valid=false
 *          with a machine-readable reason code.
 */
export async function validateGeometry(
  wktProjected: string
): Promise<ValidationResult> {
  // ── Lazy pool import ─────────────────────────────────────────────────────────
  const { pool } = await import("../db/pool.js");

  const result = await pool.query<ValidateRow>(VALIDATE_SQL, [wktProjected]);
  const row = result.rows[0];

  if (!row) {
    // Should never happen — the query always returns exactly one row.
    return {
      valid: false,
      reason: "invalid_geometry",
      detail: "Validation query returned no rows",
    };
  }

  const areaM2 = parseFloat(row.area_m2);
  const perimeterM = parseFloat(row.perimeter_m);

  // ── Gate 1: geometry validity ─────────────────────────────────────────────
  let workingWkt = wktProjected;
  let repaired = false;

  if (!row.is_valid) {
    const repairedWkt = row.make_valid_wkt;

    // Accept the repair only if it yields polygonal geometry.
    if (!repairedWkt || !isPolygonalWkt(repairedWkt)) {
      return {
        valid: false,
        reason: "invalid_geometry",
        detail: `ST_IsValidReason: ${row.invalid_reason}. ST_MakeValid produced non-polygonal result.`,
      };
    }

    // Re-query with the repaired WKT to get its area and perimeter.
    const repairedResult = await pool.query<ValidateRow>(VALIDATE_SQL, [repairedWkt]);
    const rRow = repairedResult.rows[0];

    if (!rRow || !rRow.is_valid) {
      return {
        valid: false,
        reason: "invalid_geometry",
        detail: `ST_IsValidReason: ${row.invalid_reason}. Repair attempt also invalid: ${rRow?.invalid_reason ?? "unknown"}.`,
      };
    }

    // Use the repaired geometry going forward.
    workingWkt = repairedWkt;
    repaired = true;

    // Update area and perimeter from the repaired geometry.
    const repairedArea = parseFloat(rRow.area_m2);
    const repairedPerimeter = parseFloat(rRow.perimeter_m);

    // ── Gate 2 on repaired geometry ──────────────────────────────────────────
    if (repairedArea < MIN_TERRITORY_AREA_M2) {
      return {
        valid: false,
        reason: "below_minimum_area",
        detail: `Area ${repairedArea.toFixed(2)} m² is below the minimum ${MIN_TERRITORY_AREA_M2} m².`,
      };
    }

    // ── Gate 3 on repaired geometry ──────────────────────────────────────────
    if (repairedPerimeter <= 0) {
      return {
        valid: false,
        reason: "isoperimetric_violation",
        detail: `Perimeter is zero or negative (${repairedPerimeter} m) — degenerate geometry.`,
      };
    }
    const isoMaxArea = (repairedPerimeter * repairedPerimeter / (4 * Math.PI)) * ISOPERIMETRIC_TOLERANCE;
    if (repairedArea > isoMaxArea) {
      return {
        valid: false,
        reason: "isoperimetric_violation",
        detail: `Area ${repairedArea.toFixed(2)} m² exceeds isoperimetric bound ${isoMaxArea.toFixed(2)} m² (perimeter=${repairedPerimeter.toFixed(2)} m, tolerance=${ISOPERIMETRIC_TOLERANCE}).`,
      };
    }

    return {
      valid: true,
      geometryWkt: workingWkt,
      areaM2: repairedArea,
      perimeterM: repairedPerimeter,
      repaired: true,
    };
  }

  // Input was already valid — run gates 2 and 3 on the original geometry.

  // ── Gate 2: minimum area ──────────────────────────────────────────────────
  if (areaM2 < MIN_TERRITORY_AREA_M2) {
    return {
      valid: false,
      reason: "below_minimum_area",
      detail: `Area ${areaM2.toFixed(2)} m² is below the minimum ${MIN_TERRITORY_AREA_M2} m².`,
    };
  }

  // ── Gate 3: isoperimetric check ───────────────────────────────────────────
  if (perimeterM <= 0) {
    return {
      valid: false,
      reason: "isoperimetric_violation",
      detail: `Perimeter is zero or negative (${perimeterM} m) — degenerate geometry.`,
    };
  }
  const isoMaxArea = (perimeterM * perimeterM / (4 * Math.PI)) * ISOPERIMETRIC_TOLERANCE;
  if (areaM2 > isoMaxArea) {
    return {
      valid: false,
      reason: "isoperimetric_violation",
      detail: `Area ${areaM2.toFixed(2)} m² exceeds isoperimetric bound ${isoMaxArea.toFixed(2)} m² (perimeter=${perimeterM.toFixed(2)} m, tolerance=${ISOPERIMETRIC_TOLERANCE}).`,
    };
  }

  // ── All gates passed ──────────────────────────────────────────────────────
  return {
    valid: true,
    geometryWkt: workingWkt,
    areaM2,
    perimeterM,
    repaired,
  };
}
