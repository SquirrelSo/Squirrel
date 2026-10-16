/**
 * 012: index for XP reads (ADR-027).
 *
 * XP is derived from a user's activity_sessions rows on every read, so the lookup by user must
 * not scan the table. An index only: no columns are added to the shared contract table.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = async (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS activity_sessions_user_started_idx
      ON activity_sessions (user_id, started_at);
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = async (pgm) => {
  pgm.sql("DROP INDEX IF EXISTS activity_sessions_user_started_idx;");
};
