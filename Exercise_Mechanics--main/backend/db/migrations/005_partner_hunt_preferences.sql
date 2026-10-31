-- 005: Partner Hunt preferences live in the database (with DATABASE_URL set), no longer in
-- data/users/<id>/partner_hunt.json, so they survive a redeploy. The same JSON the file held under
-- "preferences", validated by the route before it is written (partners/router.py).
-- Blocks are not here: Social owns them (ADR-032) and Partner Hunt asks it on every board.
CREATE TABLE partner_hunt_preferences (
    user_id      text PRIMARY KEY REFERENCES user_profiles (user_id) ON DELETE CASCADE,
    preferences  jsonb NOT NULL CHECK (jsonb_typeof(preferences) = 'object'),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE partner_hunt_preferences ENABLE ROW LEVEL SECURITY;  -- see 002: nothing for Supabase's Data API
