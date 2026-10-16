-- db/queries/polygonize.sql
--
-- Planar-graph face extraction via ST_Node + ST_Polygonize.
--
-- Input:  $1  — a LINESTRING WKT in a local projected CRS (e.g. AEQD metres).
--              The CRS is ephemeral and has no SRID; PostGIS treats it as SRID 0.
--              The caller is responsible for converting each face back to EPSG:4326.
--
-- Output: one row per extracted face with columns:
--   face_wkt  text             — WKT of the face polygon in the projected CRS
--   area_m2   double precision — ST_Area of the face in projected square metres
--
-- Algorithm:
--   1. ST_GeomFromText parses the input LINESTRING WKT (SRID 0).
--   2. ST_Node breaks all self-intersections into a fully noded MultiLineString.
--      This is what makes figure-eights produce two lobes instead of one
--      invalid self-intersecting ring.
--   3. ST_Polygonize extracts all enclosed face polygons from the noded linework.
--      Dangling edges (out-and-back tails) bound no face and are discarded.
--   4. ST_Dump expands the GeometryCollection into individual polygon rows.
--   5. ST_AsText serialises each face for the caller to unproject.
--
-- The aggregate ST_Polygonize is computed in an inner CTE so it is evaluated
-- once and not referenced in a WHERE clause (which would violate SQL semantics).
--
-- Parameterised query — never concatenate WKT into this string.
-- Reused by RM-3.2 (territory persistence).

WITH noded AS (
  SELECT ST_Node(ST_GeomFromText($1)) AS geom
),
polygonized AS (
  SELECT ST_Polygonize(geom) AS collection
  FROM noded
),
faces AS (
  SELECT (ST_Dump(collection)).geom AS face
  FROM polygonized
)
SELECT
  ST_AsText(face) AS face_wkt,
  ST_Area(face)   AS area_m2
FROM faces
WHERE face IS NOT NULL;
