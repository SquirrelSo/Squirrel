----
-- [0] SELECT_PENDING_EVENTS
SELECT id, territory_id, actor_id, previous_owner_id, event_type, area_delta_m2, occurred_at
FROM capture_events
WHERE id > $1
ORDER BY id ASC
LIMIT $2;

----
-- [1] SELECT_EVENT
SELECT id, territory_id, actor_id, previous_owner_id, event_type, area_delta_m2, occurred_at
FROM capture_events
WHERE id = $1;
----
-- [2] SELECT_EARLIEST_ACHIEVEMENT
SELECT actor_id, MIN(occurred_at) as min_at
FROM capture_events
WHERE actor_id = ANY($1)
GROUP BY actor_id;
