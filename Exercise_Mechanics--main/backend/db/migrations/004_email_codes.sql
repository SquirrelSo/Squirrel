-- 004: sign-up verification codes (auth/email_codes.py). One live code per address, keyed by the
-- SHA-256 of the normalized email so the table is not an address book; the code itself is stored
-- only as an HMAC. A code expires, allows a few wrong guesses, and is deleted once used.
CREATE TABLE email_verification_codes (
    email_sha256  text PRIMARY KEY CHECK (length(email_sha256) = 64),
    code_hmac     text NOT NULL,
    sent_at       timestamptz NOT NULL,
    expires_at    timestamptz NOT NULL,
    attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

ALTER TABLE email_verification_codes ENABLE ROW LEVEL SECURITY;  -- see 002: nothing for Supabase's Data API
