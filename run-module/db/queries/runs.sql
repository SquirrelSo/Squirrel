-- db/queries/runs.sql
-- Statements for RM-1.5 run session API.

----
-- [0] INSERT_RUN
INSERT INTO runs (id, user_id, status, started_at, timezone)
VALUES ($1, $2, 'active', $3, $4);

----
-- [1] SELECT_RUN_FOR_VALIDATION
SELECT user_id, status
FROM runs
WHERE id = $1;

----
-- [2] CHECK_IDEMPOTENCY
SELECT response
FROM idempotency_keys
WHERE run_id = $1 AND key = $2;

----
-- [3] INSERT_IDEMPOTENCY
INSERT INTO idempotency_keys (run_id, key, response)
VALUES ($1, $2, $3);

----
-- [4] INSERT_POINT
INSERT INTO run_points (run_id, seq, lat, lng, accuracy_m, recorded_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (run_id, seq) DO NOTHING;

----
-- [5] UPDATE_RUN_STATUS_FINISHING
UPDATE runs
SET status = 'finishing', finishing_at = now()
WHERE id = $1 AND status IN ('active', 'paused');

----
-- [6] GET_RUN_SUMMARY
SELECT
    r.id AS run_id,
    r.user_id,
    r.status,
    r.started_at,
    r.distance_m,
    r.moving_time_s,
    r.elapsed_time_s,
    r.territory_reason,
    t.id AS t_id,
    t.area_m2 AS t_area_m2,
    t.claimed_at AS t_claimed_at,
    ST_AsGeoJSON(t.geom)::jsonb AS t_geometry,
    rr.reason AS rr_reason,
    rr.detail AS rr_detail,
    rr.rejected_at AS rr_rejected_at,
    rs.aggregate AS rs_aggregate,
    rs.band AS rs_band,
    rs.layers AS rs_layers
FROM runs r
LEFT JOIN territories t ON t.run_id = r.id
LEFT JOIN run_rejections rr ON rr.run_id = r.id
LEFT JOIN run_scores rs ON rs.run_id = r.id
WHERE r.id = $1;

