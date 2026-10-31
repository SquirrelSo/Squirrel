CREATE TABLE meetups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zone_id     text REFERENCES zones(id) ON DELETE RESTRICT,
  place_text  text,
  starts_at   timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'proposed'
              CHECK (status IN ('proposed','confirmed','cancelled','completed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meetups_need_location CHECK (
    zone_id IS NOT NULL OR (place_text IS NOT NULL AND btrim(place_text) <> '')
  )
);
CREATE INDEX meetups_created_by_idx ON meetups(created_by, starts_at DESC);
CREATE INDEX meetups_status_start_idx ON meetups(status, starts_at);

CREATE TABLE meetup_participants (
  meetup_id    uuid NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('host','guest')),
  status       text NOT NULL CHECK (status IN ('invited','accepted','declined')),
  responded_at timestamptz,
  PRIMARY KEY (meetup_id, user_id),
  CONSTRAINT meetup_host_accepted CHECK (role <> 'host' OR status = 'accepted')
);
CREATE UNIQUE INDEX meetup_participants_one_host_idx ON meetup_participants(meetup_id) WHERE role = 'host';
CREATE INDEX meetup_participants_user_idx ON meetup_participants(user_id, meetup_id);
