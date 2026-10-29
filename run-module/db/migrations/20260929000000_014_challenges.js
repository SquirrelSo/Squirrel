/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(
    "CREATE TABLE challenges (" +
      "id uuid PRIMARY KEY," +
      "type text NOT NULL," +
      "title text NOT NULL," +
      "metric text NOT NULL," +
      "comparator text NOT NULL," +
      "threshold double precision NOT NULL," +
      "starts_at timestamptz NOT NULL," +
      "ends_at timestamptz NOT NULL," +
      "xp_reward integer NOT NULL," +
      "state text NOT NULL," +
      "created_by uuid NOT NULL," +
      "created_at timestamptz NOT NULL DEFAULT now()," +
      "resolved_at timestamptz" +
    ");" +
    "CREATE TABLE challenge_participants (" +
      "challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE," +
      "user_id uuid NOT NULL," +
      "status text NOT NULL," +
      "joined_at timestamptz NOT NULL DEFAULT now()," +
      "final_progress double precision," +
      "is_winner boolean," +
      "xp_awarded integer," +
      "PRIMARY KEY (challenge_id, user_id)" +
    ");" +
    "CREATE INDEX idx_challenges_state_ends_at ON challenges(state, ends_at);"
  );
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(
    "DROP TABLE IF EXISTS challenge_participants;" +
    "DROP TABLE IF EXISTS challenges;"
  );
};