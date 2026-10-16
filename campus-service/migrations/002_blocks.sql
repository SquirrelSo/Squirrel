CREATE TABLE blocks (
  blocker_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_no_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks(blocked_id, blocker_id);
