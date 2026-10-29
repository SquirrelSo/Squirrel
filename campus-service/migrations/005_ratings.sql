CREATE TABLE meetup_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meetup_id uuid NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  rater_id varchar(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ratee_id varchar(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars smallint NOT NULL CHECK (stars >= 1 AND stars <= 5),
  tags text[] NOT NULL DEFAULT '{}' CHECK (tags <@ ARRAY['friendly', 'punctual', 'fun', 'helpful']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_rating_per_pair_per_meetup UNIQUE (meetup_id, rater_id, ratee_id)
);

CREATE INDEX idx_meetup_ratings_ratee_id ON meetup_ratings(ratee_id);
