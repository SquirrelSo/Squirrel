/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE external_xp_awards (
      source text NOT NULL,
      idempotency_key text NOT NULL,
      user_id uuid NOT NULL,
      amount integer NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source, idempotency_key)
    );
    CREATE INDEX idx_external_xp_user_id ON external_xp_awards(user_id);
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS external_xp_awards;
  `);
};
