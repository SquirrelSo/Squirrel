-- DO NOT APPLY UNTIL:
--   1. SELECT count(*) FROM user_profile_details on production returns 0 (or all rows
--      have been confirmed as stale test data with no live users affected).
--   2. This service has been deployed without the profile_details read/write paths for
--      at least one release cycle (so any in-flight client versions have drained).
--
-- This migration drops the user_profile_details table that was created in
-- 004_profile_details.sql. Private profile details are now owned by the Exercise
-- service (PUT /api/me/profile-details). campus-service stopped serving this data
-- in PD-2. The table constraint "profile_details_emails_differ" and all CHECKs are
-- dropped implicitly with the table.

DROP TABLE IF EXISTS user_profile_details;
