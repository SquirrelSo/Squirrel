ALTER TABLE users RENAME COLUMN campus_xp TO xp_total;
ALTER TABLE users ADD COLUMN xp_synced_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z';