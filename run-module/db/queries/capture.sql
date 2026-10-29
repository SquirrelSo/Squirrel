-- db/queries/capture.sql

----
-- [0] SELECT_OVERLAPPING_FOR_UPDATE
SELECT 
  t.id, 
  t.owner_id, 
  t.area_m2 as old_area,
  ST_Area(ST_Intersection(t.geom, ST_GeomFromText($1, 4326))::geography) as int_area,
  ST_AsText(filtered.new_geom) as diff_wkt,
  ST_IsEmpty(filtered.new_geom) as diff_empty,
  filtered.new_area as diff_area,
  ST_IsValid(filtered.new_geom) as diff_valid,
  filtered.slivers_discarded,
  filtered.sliver_area_m2
FROM territories t
CROSS JOIN LATERAL (
  SELECT ST_Difference(t.geom, ST_GeomFromText($1, 4326)) as geom
) diff
CROSS JOIN LATERAL (
  SELECT 
    COALESCE(ST_Multi(ST_Union(d.geom) FILTER (WHERE ST_Area(d.geom::geography) >= $2::numeric)), ST_GeomFromText('MULTIPOLYGON EMPTY', 4326)) as new_geom,
    COALESCE(SUM(ST_Area(d.geom::geography)) FILTER (WHERE ST_Area(d.geom::geography) >= $2::numeric), 0) as new_area,
    COALESCE(COUNT(*) FILTER (WHERE ST_Area(d.geom::geography) < $2::numeric), 0) as slivers_discarded,
    COALESCE(SUM(ST_Area(d.geom::geography)) FILTER (WHERE ST_Area(d.geom::geography) < $2::numeric), 0) as sliver_area_m2
  FROM (
    SELECT (ST_Dump(diff.geom)).geom
  ) d
) filtered
WHERE t.state = 'active'
  AND ST_Intersects(t.geom, ST_GeomFromText($1, 4326))
ORDER BY t.id ASC
FOR UPDATE OF t;

----
-- [1] EXPIRE_TERRITORY
UPDATE territories
SET state = 'expired'
WHERE id = $1;

----
-- [2] UPDATE_TERRITORY_GEOM
UPDATE territories
SET geom = ST_GeomFromText($2, 4326),
    area_m2 = $3
WHERE id = $1;

----
-- [3] INSERT_NEW_TERRITORY
INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, expires_at, state)
VALUES ($1, $2, $3, ST_Multi(ST_GeomFromText($4, 4326)), $5, now(), now() + ($6 || ' days')::interval, 'active');

----
-- [4] INSERT_EVENT
INSERT INTO capture_events (id, territory_id, actor_id, previous_owner_id, event_type, area_delta_m2, occurred_at)
VALUES ($1, $2, $3, $4, $5, $6, now());
