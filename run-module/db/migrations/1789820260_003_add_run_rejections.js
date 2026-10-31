/**
 * db/migrations/1789820260_003_add_run_rejections.js
 *
 * Migration 003: add run_rejections table for finalization pipeline (RM-3.2).
 *
 * Rationale: see ADR-004.  The Implementation Guide section 4.1 does not
 * include a rejection-reason column on runs, and we must not alter a table
 * whose schema is specified verbatim by the IM.  A separate table keeps the
 * spec table intact and lets RM-4.6 write its own rejection rows here too.
 *
 * Note: runs.status gains a sixth value 'rejected'.  The Implementation
 * Guide (section 4.1) documents status values as a comment, not a CHECK
 * constraint, so no constraint migration is needed.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
CREATE TABLE run_rejections (
  run_id       uuid PRIMARY KEY REFERENCES runs(id),
  reason       text NOT NULL,
  detail       text,
  rejected_at  timestamptz NOT NULL DEFAULT now()
);
`);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql("DROP TABLE IF EXISTS run_rejections;");
};
