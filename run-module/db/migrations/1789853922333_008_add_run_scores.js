exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE run_scores (
      run_id      uuid PRIMARY KEY REFERENCES runs(id),
      aggregate   double precision NOT NULL,
      band        text NOT NULL,
      layers      jsonb NOT NULL,
      scored_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX run_scores_band_idx ON run_scores (band, scored_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS run_scores;`);
};
