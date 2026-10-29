/**
 * db/migrations/1789767067_001_enable_postgis.js
 *
 * Migration 001: enable the PostGIS extension idempotently.
 *
 * WHY IF NOT EXISTS:
 *   The local dev container uses the postgis/postgis image which pre-enables
 *   PostGIS in template_postgis and propagates it to run_module at creation
 *   time.  Managed Postgres (GCP Cloud SQL, RDS, etc.) does NOT do this —
 *   the extension must be created explicitly.  IF NOT EXISTS makes the
 *   migration safe in both environments.
 *
 * DOWN:
 *   Dropping PostGIS would CASCADE to every geometry column.  The down
 *   migration for 001 is intentionally a no-op.  If you need to tear down
 *   PostGIS, drop the schema first (migration 002's down), then handle
 *   the extension manually.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql("CREATE EXTENSION IF NOT EXISTS postgis;");
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (_pgm) => {
  // Intentional no-op.
  // Dropping PostGIS cascades to all geometry columns — never auto-drop.
  // To remove PostGIS manually: DROP EXTENSION postgis CASCADE;
};
