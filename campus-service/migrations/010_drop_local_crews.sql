-- Crew ownership moved to Social. Migration 009 removed the foreign keys that
-- previously required these tables; no campus runtime path reads or writes them.
DROP TABLE IF EXISTS crew_members;
DROP TABLE IF EXISTS crews;
