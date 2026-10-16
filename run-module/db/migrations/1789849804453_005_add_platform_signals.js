exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE run_point_flags (
      run_id        uuid NOT NULL REFERENCES runs(id),
      seq           integer NOT NULL,
      is_mock       boolean,
      PRIMARY KEY (run_id, seq)
    );
  `);
  pgm.sql(`
    CREATE TABLE run_batches (
      id           uuid PRIMARY KEY,
      run_id       uuid NOT NULL REFERENCES runs(id),
      uploaded_at  timestamptz NOT NULL DEFAULT now(),
      point_count  integer NOT NULL,
      first_seq    integer NOT NULL,
      last_seq     integer NOT NULL
    );
  `);
  pgm.sql(`
    CREATE INDEX run_batches_run_idx ON run_batches (run_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS run_batches;`);
  pgm.sql(`DROP TABLE IF EXISTS run_point_flags;`);
};
