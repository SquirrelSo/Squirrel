-- Crews are Social's (ADR-032): territories and challenges store Social crew ids, which never exist
-- in this service's own crews table. These foreign keys made a crew member's zone claim and every
-- crew challenge fail, so they go; Social is the authority on whether a crew exists.
ALTER TABLE territories DROP CONSTRAINT IF EXISTS territories_crew_id_fkey;
ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_target_crew_id_fkey;
ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_winner_crew_id_fkey;
