/**
 * 019: external XP awards from more sources (ADR-033).
 *
 * Adds what the award and reversal routes need, without touching existing rows: the caller's own
 * id for the thing that earned the award (source_id), a small bounded metadata object, and the
 * reversal marker. A reversed award stays in the table for audit and counts 0 on read. The
 * (source, idempotency_key) primary key and the amount > 0 check (017) are kept as they are.
 * The (user_id, created_at) index serves the per-user, per-day reads the caps need.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE external_xp_awards
      ADD COLUMN IF NOT EXISTS source_id text,
      ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
      ADD COLUMN IF NOT EXISTS reversal_reason text;
    CREATE INDEX IF NOT EXISTS idx_external_xp_user_created
      ON external_xp_awards (user_id, created_at);
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_external_xp_user_created;
    ALTER TABLE external_xp_awards
      DROP COLUMN IF EXISTS reversal_reason,
      DROP COLUMN IF EXISTS reversed_at,
      DROP COLUMN IF EXISTS metadata,
      DROP COLUMN IF EXISTS source_id;
  `);
};
