-- 002: accounts and profiles live in the database (with DATABASE_URL set), no longer in files under
-- data/, so they survive a redeploy. Sessions, captures and calibration stay in files.

-- A profile: what used to be data/users/<id>/profile.json, the same JSON. The names and email are
-- also exposed as columns (generated from the JSON) so the table reads well in the Supabase editor.
CREATE TABLE user_profiles (
    user_id     text PRIMARY KEY CHECK (user_id ~ '^[a-z0-9-]{1,64}$'),
    profile     jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object' AND profile->>'user_id' = user_id),
    first_name  text GENERATED ALWAYS AS (profile->>'first_name') STORED,
    last_name   text GENERATED ALWAYS AS (profile->>'last_name') STORED,
    email       text GENERATED ALWAYS AS (profile->>'email') STORED,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Sign-in: one row per account. The UNIQUE email is what stops two sign-ups claiming one address.
CREATE TABLE user_accounts (
    user_id        text PRIMARY KEY REFERENCES user_profiles (user_id) ON DELETE CASCADE,
    email          text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email <> ''),
    password_hash  text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens: only their SHA-256 is stored. Single use: consuming one deletes it.
CREATE TABLE user_refresh_tokens (
    token_sha256  text PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    user_id       text NOT NULL REFERENCES user_accounts (user_id) ON DELETE CASCADE,
    expires_at    timestamptz NOT NULL
);
CREATE INDEX user_refresh_tokens_user ON user_refresh_tokens (user_id);

-- The rest of a profile, one row per former file, same JSON: skill level, the answer sections
-- (fitness, activities, physique, habits), the measurement history and the append-only consent log.
-- Kept apart so a sensitive category can be erased on its own when its consent is withdrawn.
CREATE TABLE user_profile_data (
    user_id     text NOT NULL CHECK (user_id ~ '^[a-z0-9-]{1,64}$'),
    kind        text NOT NULL CHECK (kind IN ('skill', 'fitness', 'activities', 'physique', 'habits',
                                              'measurements', 'consents')),
    data        jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind)
);

-- Supabase publishes every public-schema table through its Data API (anyone with the project's anon
-- key). These hold emails, password hashes and personal details, so Row Level Security is switched on
-- with no policies: that API sees nothing. The backend connects as the tables' owner, which RLS does
-- not restrict.
ALTER TABLE user_profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profile_data   ENABLE ROW LEVEL SECURITY;
