-- Bubble: an ephemeral proximity layer. Only a coarse grid key (~250 m cell) and the containing zone are
-- stored; the coordinates sent to POST /v1/bubble/join are never written anywhere. Rows expire after
-- BUBBLE_TTL_MINUTES (15) unless refreshed by another join, and the sweeper deletes expired rows.
CREATE TABLE bubble_members (
  user_id       text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cell          text NOT NULL,
  zone_id       text REFERENCES zones(id) ON DELETE SET NULL,
  activity_type text CHECK (activity_type IN ('run','walk','workout')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX bubble_members_cell_idx ON bubble_members(cell);
CREATE INDEX bubble_members_zone_idx ON bubble_members(zone_id);
CREATE INDEX bubble_members_expires_idx ON bubble_members(expires_at);
