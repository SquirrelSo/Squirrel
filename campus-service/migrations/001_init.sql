-- Squirrel Social campus-service — initial schema.
-- Requires PostgreSQL 14+ with PostGIS 3. All geometry is WGS84 (SRID 4326); measurements use geography.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Hostels & users
-- ---------------------------------------------------------------------------
CREATE TABLE hostels (
  id          text PRIMARY KEY,           -- 'narmada'
  name        text NOT NULL,              -- 'Narmada Hostel'
  short_name  text NOT NULL,              -- 'Narmada'
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Users are provisioned just-in-time from the bearer token's `sub`. This service stores only
-- campus-social profile data; identity (email verification etc.) belongs to the account service.
CREATE TABLE users (
  id                     text PRIMARY KEY,   -- JWT sub
  display_name           text NOT NULL,
  avatar_url             text,
  bio                    text,
  email                  text,
  email_domain           text,
  hostel_id              text REFERENCES hostels(id) ON DELETE SET NULL,
  connection_mode        text CHECK (connection_mode IN ('date','friends','crew')),
  open_to_meet           boolean NOT NULL DEFAULT false,
  open_to_meet_updated_at timestamptz,
  open_to_meet_until     timestamptz,
  date_mode_enabled      boolean NOT NULL DEFAULT false,
  onboarding_completed   boolean NOT NULL DEFAULT false,
  founding_member        boolean NOT NULL DEFAULT false,
  campus_xp              integer NOT NULL DEFAULT 0 CHECK (campus_xp >= 0),
  -- Cooldowns are enforced server-side from these timestamps
  last_territory_action_at timestamptz,
  is_banned              boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_hostel_idx ON users(hostel_id);
CREATE INDEX users_campus_xp_idx ON users(campus_xp DESC);
CREATE INDEX users_open_to_meet_idx ON users(open_to_meet) WHERE open_to_meet;

-- ---------------------------------------------------------------------------
-- Crews (minimal: needed for crew-owned territory, crew challenge targets, crew filters)
-- ---------------------------------------------------------------------------
CREATE TABLE crews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  color       text,
  icon        text,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crew_members (
  crew_id    uuid NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (crew_id, user_id)
);
CREATE INDEX crew_members_user_idx ON crew_members(user_id);

-- ---------------------------------------------------------------------------
-- Zones: fixed geographic areas. Geometry never changes because of a run.
-- ---------------------------------------------------------------------------
CREATE TABLE zones (
  id              text PRIMARY KEY,                       -- 'cc1', 'narmada'
  name            text NOT NULL,
  short_name      text,
  description     text,
  kind            text NOT NULL CHECK (kind IN ('hostel','academic','sports','food','library','landmark')),
  -- AREA: qualify by covered fraction of the polygon. ROUTE: qualify by completing required_route.
  zone_type       text NOT NULL CHECK (zone_type IN ('AREA','ROUTE')),
  geometry        geometry(Polygon, 4326) NOT NULL,
  centroid        geometry(Point, 4326) NOT NULL,
  -- ROUTE zones only: the predefined route runners must complete.
  required_route  geometry(LineString, 4326),
  -- Qualification tuning (NULL → service defaults from env)
  qualify_threshold      double precision CHECK (qualify_threshold > 0 AND qualify_threshold <= 1),
  coverage_buffer_m      double precision CHECK (coverage_buffer_m > 0),
  route_tolerance_m      double precision CHECK (route_tolerance_m > 0),
  min_time_in_zone_s     integer,
  min_distance_in_zone_m double precision,
  hostel_id       text REFERENCES hostels(id) ON DELETE SET NULL,
  -- 'survey' | 'osm' | 'dev_placeholder' — placeholders must be replaced before launch
  geometry_source text NOT NULL DEFAULT 'dev_placeholder',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT zones_route_requires_geometry CHECK (zone_type <> 'ROUTE' OR required_route IS NOT NULL),
  CONSTRAINT zones_geometry_valid CHECK (ST_IsValid(geometry))
);
CREATE INDEX zones_geometry_gix ON zones USING GIST (geometry);
CREATE INDEX zones_active_idx ON zones(is_active) WHERE is_active;
CREATE INDEX zones_hostel_idx ON zones(hostel_id);

-- ---------------------------------------------------------------------------
-- Territory: exactly one row per zone => a zone can never have two owners.
-- ---------------------------------------------------------------------------
CREATE TABLE territories (
  zone_id           text PRIMARY KEY REFERENCES zones(id) ON DELETE CASCADE,
  owner_id          text REFERENCES users(id) ON DELETE SET NULL,
  owner_type        text NOT NULL DEFAULT 'NONE' CHECK (owner_type IN ('NONE','USER','CREW')),
  crew_id           uuid REFERENCES crews(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'UNCLAIMED' CHECK (status IN ('UNCLAIMED','CLAIMED','CONTESTED')),
  xp                integer NOT NULL DEFAULT 0,
  claim_count       integer NOT NULL DEFAULT 0,
  defense_count     integer NOT NULL DEFAULT 0,   -- defenses by the CURRENT owner
  claimed_at        timestamptz,
  last_defended_at  timestamptz,
  shield_until      timestamptz,
  under_challenge   boolean NOT NULL DEFAULT false,
  version           bigint NOT NULL DEFAULT 1,     -- monotonic; clients keep the highest seen
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT territories_owner_consistent CHECK (
    (owner_type = 'NONE' AND owner_id IS NULL) OR (owner_type <> 'NONE' AND owner_id IS NOT NULL)
  ),
  CONSTRAINT territories_status_consistent CHECK (
    (status = 'UNCLAIMED' AND owner_id IS NULL) OR (status <> 'UNCLAIMED' AND owner_id IS NOT NULL)
  )
);
CREATE INDEX territories_owner_idx ON territories(owner_id);
CREATE INDEX territories_status_idx ON territories(status);
CREATE INDEX territories_crew_idx ON territories(crew_id);

CREATE TABLE territory_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id            text NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  action             text NOT NULL CHECK (action IN ('CLAIM','STEAL','DEFEND','RELEASE','DECAY')),
  actor_id           text REFERENCES users(id) ON DELETE SET NULL,
  previous_owner_id  text REFERENCES users(id) ON DELETE SET NULL,
  new_owner_id       text REFERENCES users(id) ON DELETE SET NULL,
  triggered_by_activity_id uuid,      -- FK added after activities table
  qualification_id   uuid,
  xp_awarded         integer NOT NULL DEFAULT 0,
  territory_version  bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX territory_events_zone_idx ON territory_events(zone_id, created_at DESC);
CREATE INDEX territory_events_actor_idx ON territory_events(actor_id, created_at DESC);
CREATE INDEX territory_events_created_idx ON territory_events(created_at DESC);
CREATE INDEX territory_events_action_idx ON territory_events(action, created_at DESC);

-- ---------------------------------------------------------------------------
-- Activities (runs) and GPS points
-- ---------------------------------------------------------------------------
CREATE TABLE activities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type        text NOT NULL CHECK (activity_type IN ('run','walk')),
  -- RECORDING: points still being uploaded. Then the verification lifecycle.
  verification_status  text NOT NULL DEFAULT 'RECORDING'
                       CHECK (verification_status IN ('RECORDING','PENDING','PROCESSING','VERIFIED','PARTIALLY_VERIFIED','REJECTED')),
  started_at           timestamptz NOT NULL,
  ended_at             timestamptz,
  -- Client-reported (untrusted, kept for anti-cheat comparison only)
  client_distance_m    double precision,
  client_duration_s    integer,
  -- Server-derived from points (authoritative)
  distance_m           double precision,
  duration_s           integer,
  moving_time_s        integer,
  point_count          integer NOT NULL DEFAULT 0,
  track                geometry(LineString, 4326),   -- cleaned track after verification
  raw_track            geometry(LineString, 4326),   -- as uploaded
  anti_cheat_score     double precision CHECK (anti_cheat_score >= 0 AND anti_cheat_score <= 1),
  -- Internal detail; never returned verbatim to clients
  verification_reason  text,
  verification_signals jsonb,
  verification_attempts integer NOT NULL DEFAULT 0,
  device_metadata      jsonb,
  finished_at          timestamptz,
  verified_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_user_started_idx ON activities(user_id, started_at DESC);
CREATE INDEX activities_status_idx ON activities(verification_status);
CREATE INDEX activities_started_idx ON activities(started_at DESC);
CREATE INDEX activities_track_gix ON activities USING GIST (track);
CREATE INDEX activities_pending_idx ON activities(finished_at) WHERE verification_status IN ('PENDING','PROCESSING');

ALTER TABLE territory_events
  ADD CONSTRAINT territory_events_activity_fk FOREIGN KEY (triggered_by_activity_id) REFERENCES activities(id) ON DELETE SET NULL;

CREATE TABLE activity_points (
  activity_id  uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  geom         geometry(Point, 4326) NOT NULL,
  recorded_at  timestamptz NOT NULL,
  accuracy_m   double precision NOT NULL,
  speed_ms     double precision,      -- device-reported, optional
  altitude_m   double precision,
  PRIMARY KEY (activity_id, seq)
);
CREATE INDEX activity_points_geom_gix ON activity_points USING GIST (geom);
CREATE INDEX activity_points_recorded_idx ON activity_points(activity_id, recorded_at);

-- Replays of the same point batch (client retries) are recognised by key
CREATE TABLE activity_point_batches (
  activity_id     uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  seq_from        integer NOT NULL,
  seq_to          integer NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- Qualification results: one per (activity, zone). Never changes ownership by itself.
-- ---------------------------------------------------------------------------
CREATE TABLE qualification_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id         uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id             text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zone_id             text NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  status              text NOT NULL CHECK (status IN ('NOT_QUALIFIED','PENDING','QUALIFIED','CLAIMED','EXPIRED')),
  verified            boolean NOT NULL DEFAULT false,
  interaction         text NOT NULL CHECK (interaction IN ('passed_through','looped','visited')),
  coverage            double precision,          -- AREA zones: 0..1
  route_completion    double precision,          -- ROUTE zones: 0..1
  distance_in_zone_m  double precision NOT NULL DEFAULT 0,
  time_in_zone_s      integer NOT NULL DEFAULT 0,
  threshold           double precision,
  claim_available     boolean NOT NULL DEFAULT false,
  evaluated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  consumed_by_event_id uuid REFERENCES territory_events(id) ON DELETE SET NULL,
  UNIQUE (activity_id, zone_id)
);
CREATE INDEX qualification_user_zone_idx ON qualification_results(user_id, zone_id, status, expires_at DESC);
CREATE INDEX qualification_zone_status_idx ON qualification_results(zone_id, status, expires_at);
CREATE INDEX qualification_expiry_idx ON qualification_results(expires_at) WHERE status = 'QUALIFIED';

-- ---------------------------------------------------------------------------
-- Idempotency for ownership-changing writes
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          text NOT NULL,
  scope        text NOT NULL,              -- 'territory:claim:cc1'
  status_code  integer NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys(created_at);

-- ---------------------------------------------------------------------------
-- Verification job queue (Postgres-backed, SKIP LOCKED)
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,             -- 'verify_activity'
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  attempts      integer NOT NULL DEFAULT 0,
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pick_idx ON jobs(status, run_after) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX jobs_verify_activity_once ON jobs ((payload->>'activity_id')) WHERE kind = 'verify_activity' AND status IN ('queued','running');

-- ---------------------------------------------------------------------------
-- Presence (Active Now / Nearby). Exact position is stored for distance math but is never
-- returned; clients only ever get proximity buckets or grid-snapped positions.
-- ---------------------------------------------------------------------------
CREATE TABLE presence (
  user_id        text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  geom           geometry(Point, 4326) NOT NULL,
  accuracy_m     double precision,
  activity_type  text CHECK (activity_type IN ('run','walk','workout')),
  activity_id    uuid REFERENCES activities(id) ON DELETE SET NULL,
  activity_started_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX presence_geom_gix ON presence USING GIST (geom);
CREATE INDEX presence_expires_idx ON presence(expires_at);

-- ---------------------------------------------------------------------------
-- Challenges (the app calls these "challenge invites")
-- ---------------------------------------------------------------------------
CREATE TABLE challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL CHECK (type IN ('territory','weekend_war','zone_race','group_activity')),
  created_by    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type   text NOT NULL CHECK (target_type IN ('user','crew')),
  target_user_id text REFERENCES users(id) ON DELETE CASCADE,
  target_crew_id uuid REFERENCES crews(id) ON DELETE CASCADE,
  zone_id       text REFERENCES zones(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','declined','cancelled','expired','active','completed')),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  message       text,
  responded_by  text REFERENCES users(id) ON DELETE SET NULL,
  responded_at  timestamptz,
  started_at    timestamptz,
  completed_at  timestamptz,
  winner_user_id text REFERENCES users(id) ON DELETE SET NULL,
  winner_crew_id uuid REFERENCES crews(id) ON DELETE SET NULL,
  result_summary text,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenges_target_consistent CHECK (
    (target_type = 'user' AND target_user_id IS NOT NULL AND target_crew_id IS NULL) OR
    (target_type = 'crew' AND target_crew_id IS NOT NULL AND target_user_id IS NULL)
  )
);
CREATE INDEX challenges_status_idx ON challenges(status, starts_at);
CREATE INDEX challenges_creator_idx ON challenges(created_by, created_at DESC);
CREATE INDEX challenges_target_user_idx ON challenges(target_user_id, created_at DESC);
CREATE INDEX challenges_target_crew_idx ON challenges(target_crew_id, created_at DESC);
CREATE INDEX challenges_zone_idx ON challenges(zone_id) WHERE status IN ('pending','accepted','active');
CREATE INDEX challenges_starts_idx ON challenges(starts_at);

-- ---------------------------------------------------------------------------
-- Notifications (backend events only; no delivery UI here)
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,     -- see notifications/service.ts for the catalogue
  actor_id    text REFERENCES users(id) ON DELETE SET NULL,
  text        text NOT NULL,
  data        jsonb,
  read        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE NOT read;
