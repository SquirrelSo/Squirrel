-- db/queries/decay.sql

----
-- [0] SELECT_EXPIRING_TERRITORIES
SELECT id, owner_id, area_m2 
FROM territories 
WHERE state = 'active' AND expires_at <= $1
ORDER BY id ASC
LIMIT $2
FOR UPDATE;

----
-- [1] EXPIRE_TERRITORIES
UPDATE territories
SET state = 'expired'
WHERE id = ANY($1);

----
-- [2] INSERT_EXPIRED_EVENT
INSERT INTO capture_events (id, territory_id, actor_id, previous_owner_id, event_type, area_delta_m2, occurred_at)
VALUES ($1, $2, $3, $4, $5, $6, $7);
