-- 003: counters for the sign-in limits (auth/throttle.py), shared by every app instance.
-- One row per (what, who): e.g. 'login-email:<sha256 of the email>' or 'signup-ip:<address>'.
-- A fixed window: `hits` counts from `window_start` until the window has passed.
CREATE TABLE auth_throttle (
    key           text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200),
    window_start  timestamptz NOT NULL,
    hits          integer NOT NULL CHECK (hits >= 0)
);

ALTER TABLE auth_throttle ENABLE ROW LEVEL SECURITY;  -- see 002: nothing for Supabase's Data API
