exports.up = (pgm) => {
  pgm.sql("ALTER TABLE runs ADD COLUMN territory_reason text;");
};

exports.down = (pgm) => {
  pgm.sql("ALTER TABLE runs DROP COLUMN territory_reason;");
};
