/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(
    "ALTER TABLE external_xp_awards ADD CONSTRAINT external_xp_amount_check CHECK (amount > 0);"
  );
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(
    "ALTER TABLE external_xp_awards DROP CONSTRAINT external_xp_amount_check;"
  );
};