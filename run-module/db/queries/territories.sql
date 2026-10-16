-- GET_TERRITORIES_MINE
-- Returns up to 201 active territories for a user to determine if we need to set truncated=true
SELECT
    id,
    area_m2,
    claimed_at,
    expires_at,
    state,
    ST_AsGeoJSON(geom)::jsonb AS geometry
FROM territories
WHERE owner_id = $1 AND state = 'active'
ORDER BY claimed_at DESC
LIMIT 201;
