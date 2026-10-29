-- 008: Partner Hunt Connect (backend/partners/connect.py). A request from one member to another;
-- only once it is accepted does each learn the other's Social profile. `declined` is never shown to
-- the sender (a decline is silent), and `withdrawn` is the sender taking a request back.
CREATE TABLE partner_requests (
    request_id   text PRIMARY KEY,
    from_user    text NOT NULL REFERENCES user_profiles (user_id) ON DELETE CASCADE,
    to_user      text NOT NULL REFERENCES user_profiles (user_id) ON DELETE CASCADE,
    status       text NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
    created_at   timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL,
    decided_at   timestamptz,
    CHECK (from_user <> to_user)
);

CREATE INDEX partner_requests_from ON partner_requests (from_user, created_at);
CREATE INDEX partner_requests_to ON partner_requests (to_user);

ALTER TABLE partner_requests ENABLE ROW LEVEL SECURITY;  -- see 002: nothing for Supabase's Data API
