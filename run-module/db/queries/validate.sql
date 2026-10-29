-- db/queries/validate.sql
--
-- Geometry validation query for a single polygon in a projected CRS.
--
-- Input:  $1 — POLYGON (or MULTIPOLYGON) WKT in a local projected CRS.
--              PostGIS treats it as SRID 0.  Area/perimeter are in the
--              CRS units (metres for AEQD).
--
-- Output: one row with:
--   is_valid        boolean  — ST_IsValid result
--   invalid_reason  text     — ST_IsValidReason (empty string when valid)
--   area_m2         double   — ST_Area in projected sq-metres
--   perimeter_m     double   — ST_Perimeter in projected metres
--   make_valid_wkt  text     — ST_AsText(ST_MakeValid(...)); the caller
--                              decides whether to use it
--
-- Using a single query avoids multiple round-trips and ensures area and
-- perimeter are computed on the SAME geometry object.
--
-- Parameterised query — the WKT is always $1, never concatenated.
-- Used by validate.ts (RM-2.5) and potentially RM-3.2.

SELECT
  ST_IsValid(g)                    AS is_valid,
  ST_IsValidReason(g)              AS invalid_reason,
  ST_Area(g)                       AS area_m2,
  ST_Perimeter(g)                  AS perimeter_m,
  ST_AsText(ST_MakeValid(g))       AS make_valid_wkt
FROM (
  SELECT ST_GeomFromText($1) AS g
) AS t;
