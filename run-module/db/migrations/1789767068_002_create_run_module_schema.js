/**
 * db/migrations/1789767068_002_create_run_module_schema.js
 *
 * Migration 002: create all Run Module tables and spatial indexes.
 *
 * Schema transcribed verbatim from Implementation Guide section 4.1.
 * Nothing added, nothing removed. See ticket RM-3.1 for the authority.
 *
 * Deliberate omissions (by spec):
 *   - No DEFAULT gen_random_uuid() on any id — UUIDs are app-generated.
 *   - No FK on user_id / owner_id / actor_id — identity is external.
 *   - No CHECK constraints on status / state / event_type — documented
 *     as comments only.
 *   - No updated_at columns.
 *   - No leaderboard_snapshots table (added at RM-6.3).
 *   - No indexes beyond the two specified.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
CREATE TABLE runs (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL,
  started_at      timestamptz NOT NULL,
  status          text NOT NULL,   -- active|paused|finishing|finalized
  distance_m      double precision,
  moving_time_s   integer,
  elapsed_time_s  integer
);
`);

  pgm.sql(`
CREATE TABLE run_points (
  run_id       uuid NOT NULL REFERENCES runs(id),
  seq          integer NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  accuracy_m   double precision,
  recorded_at  timestamptz NOT NULL,
  PRIMARY KEY (run_id, seq)
);
`);

  pgm.sql(`
CREATE TABLE territories (
  id          uuid PRIMARY KEY,
  owner_id    uuid NOT NULL,
  run_id      uuid NOT NULL REFERENCES runs(id),
  geom        geometry(MultiPolygon, 4326) NOT NULL,
  area_m2     double precision NOT NULL,
  claimed_at  timestamptz NOT NULL,
  expires_at  timestamptz,
  state       text NOT NULL    -- active|contested|expired
);
`);

  pgm.sql(`CREATE INDEX territories_geom_gix ON territories USING GIST (geom);`);

  pgm.sql(`
CREATE INDEX territories_owner_idx ON territories (owner_id)
  WHERE state = 'active';
`);

  pgm.sql(`
CREATE TABLE capture_events (
  id                 uuid PRIMARY KEY,
  territory_id       uuid NOT NULL,
  actor_id           uuid NOT NULL,
  previous_owner_id  uuid,
  event_type         text NOT NULL,
    -- claimed|partial_capture|full_capture|expired
  area_delta_m2      double precision,
  occurred_at        timestamptz NOT NULL
);
`);

  // Shared contract with the Exercise Module (write-only from here).
  // Do not add exercise-specific columns to this table.
  pgm.sql(`
CREATE TABLE activity_sessions (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL,
  type           text NOT NULL,   -- 'run' for every row this repo writes
  subtype        text NOT NULL,   -- 'territory_run'
  started_at     timestamptz NOT NULL,
  duration_s     integer NOT NULL,
  intensity      text,
  calories_kcal  numeric,
  metrics        jsonb NOT NULL,  -- {distance_m, area_m2, ...}
  source_module  text NOT NULL DEFAULT 'run_module',
  created_at     timestamptz NOT NULL DEFAULT now()
);
`);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  // Drop in reverse dependency order.
  pgm.sql("DROP TABLE IF EXISTS activity_sessions;");
  pgm.sql("DROP TABLE IF EXISTS capture_events;");
  pgm.sql("DROP TABLE IF EXISTS territories;");
  pgm.sql("DROP TABLE IF EXISTS run_points;");
  pgm.sql("DROP TABLE IF EXISTS runs;");
};
