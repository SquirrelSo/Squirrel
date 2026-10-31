-- db/queries/tiles.sql
-- Statements for RM-3.3 MVT tile endpoint

----
-- [0] GET_TERRITORIES_TILE
-- NOTE: This endpoint MUST use Web Mercator (EPSG:3857). ADR-001 and RM-2.1
-- forbid Web Mercator for MEASUREMENT (it inflates area by sec^2(lat)), but
-- vector tiles are DEFINED in Web Mercator. Using it for tile rendering is
-- correct and required. Do not "fix" this to match the projection ADR.

SELECT ST_AsMVT(mvtgeom.*, 'territories') AS tile
FROM (
  SELECT
    id,
    owner_id,
    area_m2,
    state,
    ST_AsMVTGeom(
      ST_Transform(geom, 3857),
      ST_TileEnvelope($1::integer, $2::integer, $3::integer),
      4096,
      64,
      true
    ) AS geom
  FROM territories
  WHERE state = 'active'
    AND geom && ST_Transform(ST_TileEnvelope($1::integer, $2::integer, $3::integer), 4326)
) mvtgeom;
