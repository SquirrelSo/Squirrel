/**
 * src/geometry/constants.ts
 *
 * Named constants for the geometry pipeline.
 * Import from here rather than using magic numbers in callsites.
 */

/**
 * Default Douglas–Peucker simplification epsilon in metres.
 *
 * The specification allows 3–5 m. 4 m is chosen as the midpoint,
 * balancing noise suppression (GPS jitter is typically 1–3 m) against
 * shape fidelity (features ≥ 4 m are preserved).
 *
 * RM-2.6 and later tickets import this constant directly.
 */
export const SIMPLIFY_EPSILON_M = 4;

/**
 * Maximum start-to-end gap in metres for snap-close (RM-2.3).
 *
 * A track whose start-to-end gap is ≤ this value is closed into a ring.
 * A track with a larger gap is flagged as not-closed and returned unchanged.
 *
 * Gap is measured in PROJECTED METRES via the AEQD local projection —
 * never in degrees (a degree of longitude is latitude-dependent).
 *
 * Exactly 30 m is treated as closeable (inclusive ≤).
 *
 * RM-2.5 converts a not-closed result into a rejection reason code.
 */
export const SNAP_CLOSE_MAX_GAP_M = 30;

/**
 * Minimum allowed territory area in square metres (RM-2.5).
 *
 * Territories smaller than this are rejected with reason
 * 'below_minimum_area'.  The value comes directly from the specification
 * (section 4.2).  It is not an engineering choice — do not adjust it here;
 * update the spec first.
 *
 * 500 m² ≈ a 22 m × 22 m square — small enough to be a legitimate minimal
 * territory but large enough to exclude microfaces from self-intersections.
 */
export const MIN_TERRITORY_AREA_M2 = 500;

/**
 * Isoperimetric tolerance factor (RM-2.5, see ADR-002).
 *
 * The classical isoperimetric inequality states that for any closed curve of
 * perimeter P enclosing area A:
 *   A ≤ P² / (4π)
 * with equality only for a perfect circle.
 *
 * Real GPS tracks are never perfect circles; they always satisfy the
 * inequality strictly.  This tolerance factor relaxes the check to:
 *   A ≤ (P² / (4π)) × ISOPERIMETRIC_TOLERANCE
 * so that very round tracks (uncommon but valid) are not falsely rejected.
 *
 * 1.05 allows 5% above the theoretical maximum — chosen because PostGIS
 * area and perimeter calculations have floating-point rounding, and
 * reprojection from AEQD → EPSG:4326 introduces sub-percent distortion.
 * A value above 1.10 would mask genuinely inconsistent geometry.
 *
 * See ADR-002 (docs/decisions/ADR-002-geometry-validation-thresholds.md).
 */
export const ISOPERIMETRIC_TOLERANCE = 1.05;
