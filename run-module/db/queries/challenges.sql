-- INSERT_CHALLENGE
INSERT INTO challenges (id, type, title, metric, comparator, threshold, starts_at, ends_at, xp_reward, state, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;

----
-- INSERT_PARTICIPANT
INSERT INTO challenge_participants (challenge_id, user_id, status)
VALUES ($1, $2, $3) RETURNING *;

----
-- UPDATE_PARTICIPANT_STATUS
UPDATE challenge_participants SET status = $2 WHERE challenge_id = $1 AND user_id = $3 RETURNING *;

----
-- UPDATE_CHALLENGE_STATE
UPDATE challenges SET state = $2 WHERE id = $1 RETURNING *;

----
-- GET_CHALLENGE
SELECT * FROM challenges WHERE id = $1;

----
-- GET_PARTICIPANTS
SELECT * FROM challenge_participants WHERE challenge_id = $1;

----
-- CHECK_PARTICIPANT
SELECT 1 FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2;

----
-- LIST_MY_CHALLENGES
WITH my_challenges AS (
  SELECT c.*, cp.user_id AS participant_user_id, cp.status AS participant_status,
         cp.is_winner, cp.xp_awarded
  FROM challenges c
  JOIN challenge_participants cp ON cp.challenge_id = c.id
  WHERE cp.user_id = $1
),
progress_subjects AS (
  SELECT mc.id AS challenge_id, mc.metric, mc.starts_at, mc.ends_at,
         mc.participant_user_id AS user_id, mc.participant_status AS status,
         mc.is_winner, mc.xp_awarded
  FROM my_challenges mc
  UNION ALL
  SELECT mc.id, mc.metric, mc.starts_at, mc.ends_at,
         cp.user_id, cp.status, cp.is_winner, cp.xp_awarded
  FROM my_challenges mc
  JOIN challenge_participants cp ON cp.challenge_id = mc.id
  WHERE mc.type = 'group' AND cp.status = 'accepted' AND cp.user_id <> $1
),
participant_progress AS (
  SELECT ps.challenge_id, ps.user_id, ps.status, ps.is_winner, ps.xp_awarded,
         COALESCE(SUM(
           CASE
             WHEN a.id IS NULL OR a.type <> 'run' THEN 0::double precision
             WHEN ps.metric = 'distance_m'
               AND jsonb_typeof(a.metrics -> 'distance_m') = 'number'
               THEN (a.metrics ->> 'distance_m')::double precision
             WHEN ps.metric = 'duration_s'
               AND jsonb_typeof(a.metrics -> 'elapsed_time_s') = 'number'
               THEN (a.metrics ->> 'elapsed_time_s')::double precision
             WHEN ps.metric = 'runs_completed' THEN 1::double precision
             WHEN ps.metric = 'territory_area_m2'
               AND a.metrics -> 'territory_claimed' = 'true'::jsonb
               AND jsonb_typeof(a.metrics -> 'area_m2') = 'number'
               THEN (a.metrics ->> 'area_m2')::double precision
             WHEN ps.metric = 'territories_captured'
               AND a.metrics -> 'territory_claimed' = 'true'::jsonb
               THEN 1::double precision
             ELSE 0::double precision
           END
         ), 0)::double precision AS progress
  FROM progress_subjects ps
  LEFT JOIN activity_sessions a
    ON a.user_id = ps.user_id
   AND a.started_at >= ps.starts_at
   AND a.started_at <= ps.ends_at
  GROUP BY ps.challenge_id, ps.user_id, ps.status, ps.is_winner, ps.xp_awarded
),
group_totals AS (
  SELECT challenge_id,
         COALESCE(SUM(progress) FILTER (WHERE status = 'accepted'), 0)::double precision AS group_progress,
         COUNT(*) FILTER (WHERE status = 'accepted')::integer AS group_member_count
  FROM participant_progress
  GROUP BY challenge_id
)
SELECT c.id,
       c.type,
       c.title,
       c.metric,
       c.comparator,
       c.threshold,
       c.starts_at AS "startsAt",
       c.ends_at AS "endsAt",
       c.xp_reward AS "xpReward",
       c.state,
       c.created_by AS "createdBy",
       c.created_at AS "createdAt",
       c.resolved_at AS "resolvedAt",
       mc.participant_status AS "participantStatus",
       mc.is_winner AS "isWinner",
       mc.xp_awarded AS "xpAwarded",
       mine.progress AS "myProgress",
       CASE WHEN c.type = 'group' THEN COALESCE(gt.group_progress, 0)::double precision
            ELSE NULL::double precision END AS "groupProgress",
       CASE WHEN c.type = 'group' THEN COALESCE(gt.group_member_count, 0)::integer
            ELSE NULL::integer END AS "groupMemberCount"
FROM my_challenges mc
JOIN challenges c ON c.id = mc.id
JOIN participant_progress mine ON mine.challenge_id = mc.id AND mine.user_id = $1
LEFT JOIN group_totals gt ON gt.challenge_id = mc.id
ORDER BY c.ends_at DESC;

----
-- RESOLVER_GET_RESOLVABLE
SELECT * FROM challenges 
WHERE state = 'active' AND ends_at <= now()
LIMIT $1;

----
-- RESOLVER_GET_ACTIVITY
SELECT type, metrics FROM activity_sessions 
WHERE user_id = $1 AND started_at >= $2 AND started_at <= $3;

----
-- RESOLVER_UPDATE_PARTICIPANT
UPDATE challenge_participants 
SET final_progress = $2, is_winner = $3, xp_awarded = $4
WHERE challenge_id = $1 AND user_id = $5;

----
-- RESOLVER_UPDATE_CHALLENGE
UPDATE challenges SET state = 'resolved', resolved_at = now() WHERE id = $1 RETURNING *;
