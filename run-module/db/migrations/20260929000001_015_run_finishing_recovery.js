/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE runs ADD COLUMN finishing_at timestamptz;
    UPDATE runs SET finishing_at = now() WHERE status = 'finishing';
    CREATE INDEX runs_finishing_recovery_idx ON runs (finishing_at)
      WHERE status = 'finishing';
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS runs_finishing_recovery_idx;
    ALTER TABLE runs DROP COLUMN IF EXISTS finishing_at;
  `);
};
