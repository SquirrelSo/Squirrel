-- 007: Workout with Partner (backend/shared_workouts/). One row per shared session; `doc` is the
-- session document from shared_workouts/model.py, written whole under a row lock. The phase is never
-- stored: it is worked out from the document's timestamps on every read.
--   member_ids  the login subjects still holding a seat, so "already in a session?" is one indexed query
--   closes_at   the latest moment the session can still be in play (ends_at + the rep grace, or the
--               lobby's expiry); rows are deleted a week after it
CREATE TABLE shared_workout_sessions (
    session_id   text PRIMARY KEY,
    invite_code  text NOT NULL UNIQUE,
    member_ids   text[] NOT NULL DEFAULT '{}',
    closes_at    timestamptz NOT NULL,
    doc          jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object'),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shared_workout_sessions_members ON shared_workout_sessions USING gin (member_ids);
CREATE INDEX shared_workout_sessions_closes_at ON shared_workout_sessions (closes_at);

ALTER TABLE shared_workout_sessions ENABLE ROW LEVEL SECURITY;  -- see 002: nothing for Supabase's Data API
