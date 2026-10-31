exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE leaderboard_snapshots (
      id uuid PRIMARY KEY,
      scope text NOT NULL,
      "window" text NOT NULL,
      user_id uuid NOT NULL,
      score double precision NOT NULL,
      rank integer NOT NULL,
      captured_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX leaderboard_snapshots_lookup_idx
      ON leaderboard_snapshots (scope, "window", captured_at DESC);
  `);
};

exports.down = async (pgm) => {
  pgm.sql("DROP TABLE leaderboard_snapshots;");
};
