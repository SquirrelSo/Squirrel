-- Private onboarding details ("About you"): name, contact, gender, age, course, CGPA.
-- Kept in its own table, NOT on `users`: `users` rows are read with SELECT * all over the service
-- (public profiles, leaderboards, map players), so personal data there would be one careless
-- column-list away from leaking. This table is only ever read by GET/PATCH /v1/me for the owner.
-- The CHECKs mirror the API validation (src/users/details.ts) so a bad row can't exist even if a
-- future code path skips the API layer.
CREATE TABLE user_profile_details (
  user_id        text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name      text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 60),
  personal_email text NOT NULL CHECK (char_length(personal_email) <= 254),
  college_email  text NOT NULL CHECK (char_length(college_email) <= 254),
  phone          text NOT NULL CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),  -- E.164, Indian mobile
  gender         text NOT NULL CHECK (gender IN ('female','male','non_binary','undisclosed')),
  age            smallint NOT NULL CHECK (age BETWEEN 16 AND 99),
  course         text NOT NULL CHECK (char_length(course) BETWEEN 1 AND 60),
  cgpa           numeric(4,2) CHECK (cgpa BETWEEN 0 AND 10),           -- optional, 10-point scale
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_details_emails_differ CHECK (lower(personal_email) <> lower(college_email))
);
