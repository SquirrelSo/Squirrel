-- 006: the private details of the app's "About you" form that sign-up never asked (ADR-032 open item 1:
-- Exercise is their one home). GET/PUT /api/me/profile-details (profiles/service.py). The rest of
-- the form is NOT copied here: name, mobile, gender, date of birth (age) and the sign-in email stay
-- in user_profiles, their only source. Owner-only; never on a public profile.
-- The CHECKs mirror the API validation (profiles/models.py ProfileDetailsIn).
CREATE TABLE user_personal_details (
    user_id         text PRIMARY KEY REFERENCES user_profiles (user_id) ON DELETE CASCADE,
    personal_email  text NOT NULL CHECK (char_length(personal_email) <= 254
                                         AND personal_email = lower(personal_email)
                                         AND personal_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
    course          text NOT NULL CHECK (char_length(course) BETWEEN 1 AND 60),
    cgpa            numeric(4,2) CHECK (cgpa BETWEEN 0 AND 10),  -- optional, 10-point scale
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_personal_details ENABLE ROW LEVEL SECURITY;  -- see 002: nothing for Supabase's Data API
