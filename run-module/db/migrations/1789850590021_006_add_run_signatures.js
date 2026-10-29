exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE run_signatures (
      run_id        uuid PRIMARY KEY REFERENCES runs(id),
      user_id       uuid NOT NULL,
      point_hash    text NOT NULL,
      geom_centroid geometry(Point, 4326),
      area_m2       double precision,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`
    CREATE INDEX run_signatures_user_idx
      ON run_signatures (user_id, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS run_signatures;`);
};
