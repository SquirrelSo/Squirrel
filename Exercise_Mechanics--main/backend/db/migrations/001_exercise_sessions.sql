-- 001: one row per exercise session, for the exercises this backend coaches.
--
-- Only parameters that apply to those exercises. Running-only measures (distance, steps, pace, speed)
-- are deliberately absent; activity-specific parameters are added later as their own migrations,
-- not stuffed in up front.

-- The exercises a session can be. Seeded from the workout catalog's ENABLED entries; a new exercise
-- is one INSERT here when it is enabled, not a schema change.
CREATE TABLE activity_types (
    code     text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{1,40}$'),
    label    text NOT NULL,
    measure  text NOT NULL CHECK (measure IN ('reps', 'time'))  -- rep-counted, or timed (high knees)
);

INSERT INTO activity_types (code, label, measure) VALUES
    ('squat',      'Squat',      'reps'),
    ('pushup',     'Push-up',    'reps'),
    ('bicep_curl', 'Bicep curl', 'reps'),
    ('high_knee',  'High knees', 'time');

CREATE TABLE exercise_sessions (
    session_id       text PRIMARY KEY CHECK (session_id ~ '^[A-Za-z0-9_-]{1,80}$'),
    -- Today's member ids (name-slug + hash). Becomes the account service's UUID when that exists.
    user_id          text NOT NULL CHECK (user_id ~ '^[a-z0-9-]{1,64}$'),
    activity_type    text NOT NULL REFERENCES activity_types (code),
    start_time       timestamptz NOT NULL,             -- when the session was started
    end_time         timestamptz,                      -- when its last set finished; NULL until one has
    duration_s       integer CHECK (duration_s >= 0),  -- active exercise time across its sets
    calories_kcal    numeric(7, 1) CHECK (calories_kcal >= 0),  -- NULL until calories are calculated
    sets             smallint NOT NULL DEFAULT 0 CHECK (sets >= 0),   -- sets completed
    reps             integer  NOT NULL DEFAULT 0 CHECK (reps >= 0),   -- reps completed (high knees: counted lifts)
    workout_score    smallint CHECK (workout_score BETWEEN 0 AND 100),   -- system-generated
    activity_rating  smallint CHECK (activity_rating BETWEEN 1 AND 5),   -- the member's own, if given
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (end_time IS NULL OR end_time >= start_time)
);

CREATE INDEX exercise_sessions_user_start ON exercise_sessions (user_id, start_time DESC);
