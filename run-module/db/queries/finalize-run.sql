-- db/queries/finalize-run.sql
--
-- SQL fragments for the run finalization worker (RM-3.2).
--
-- These are parameterised statements — never concatenate untrusted values.
-- Each statement is separated by a ---- sentinel comment and identified by
-- its KEY so finalize.ts can split and select them by index.
--
-- Statement order:
--   [0] SELECT_RUN_FOR_UPDATE   — lock the run row, read owner
--   [1] SELECT_POINTS           — load run_points ordered by seq
--   [2] UPDATE_STATUS           — set runs.status ($1=status, $2=run_id)
--   [3] INSERT_REJECTION        — insert run_rejections row
--   [4] INSERT_TERRITORY        — insert territories row
--
-- All statements are used inside a single transaction in finalize.ts.

----
-- [0] SELECT_RUN_FOR_UPDATE
-- Lock the run row for the duration of the transaction.
-- Returns fields needed for idempotency and the activity_session write.
SELECT user_id, status, started_at, distance_m, elapsed_time_s, timezone
FROM   runs
WHERE  id = $1
FOR UPDATE;

----
-- [1] SELECT_POINTS
-- Load run_points in recording order, strictly by seq.
SELECT lat, lng, recorded_at
FROM   run_points
WHERE  run_id = $1
ORDER  BY seq;

----
-- [2] UPDATE_STATUS
-- Set the run's status.  Called twice: once on rejection, once on success.
-- $1 = new status ('finalized' | 'rejected')
-- $2 = run_id
UPDATE runs
SET    status = $1
WHERE  id     = $2;

----
-- [3] INSERT_REJECTION
-- Record the geometry pipeline's rejection reason.
-- $1 = run_id, $2 = reason (text), $3 = detail (text | null)
INSERT INTO run_rejections (run_id, reason, detail)
VALUES ($1, $2, $3);

----
-- [4] INSERT_TERRITORY
-- Insert a new territory row.  All metric and geometry values come from the
-- server-side pipeline — never from a client-supplied parameter.
-- $1 = id (uuid, generated server-side)
-- $2 = owner_id (uuid, from runs.user_id — never a function parameter)
-- $3 = run_id (uuid)
-- $4 = geometry WKT (MULTIPOLYGON, EPSG:4326, from processTrack)
-- $5 = area_m2 (double precision, from ST_Union +' validateGeometry, NOT a face sum)
INSERT INTO territories (id, owner_id, run_id, geom, area_m2, claimed_at, expires_at, state)
VALUES (
  $1,
  $2,
  $3,
  ST_Multi(ST_GeomFromText($4, 4326)),
  $5,
  now(),
  NULL,
  'active'
);

----
-- [5] CHECK_TERRITORY_AREA
-- Recompute the area of the stored geometry to ensure it matches the pipeline's
-- areaM2 (which was computed before any insert-time ST_MakeValid repairs).
-- $1 = id (uuid)
SELECT 
  ST_Area(geom::geography) AS recomputed_area,
  ST_IsEmpty(geom) AS is_empty,
  ST_NumGeometries(geom) AS num_geoms
FROM territories
WHERE id = $1;

----
-- [6] INSERT_ACTIVITY_SESSION
-- Insert the shared contract row for the Exercise Module.
-- Called exactly once per finalized run, whether successful or rejected.
-- $1 = id (uuid), $2 = user_id, $3 = started_at, $4 = duration_s,
-- $5 = intensity (low|moderate|vigorous|null), $6 = metrics (jsonb)
INSERT INTO activity_sessions (
  id, user_id, type, subtype, started_at, duration_s,
  intensity, calories_kcal, metrics, source_module, created_at
) VALUES (
  $1, $2, 'run', 'territory_run', $3, $4,
  $5, NULL, $6, 'run_module', now()
);
