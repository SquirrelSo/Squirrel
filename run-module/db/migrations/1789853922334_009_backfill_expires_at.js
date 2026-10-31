exports.up = async (pgm) => {
  pgm.sql("UPDATE territories SET expires_at = claimed_at + interval '14 days' WHERE expires_at IS NULL");
  pgm.sql("CREATE INDEX territories_expiry_idx ON territories (expires_at) WHERE state = 'active'");
};

exports.down = async (pgm) => {
  pgm.sql("DROP INDEX IF EXISTS territories_expiry_idx");
};
