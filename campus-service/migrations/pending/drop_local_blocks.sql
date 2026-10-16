-- WI-07 (ADR-032): drop campus-service's legacy `blocks` table. Blocks are owned by Social.
--
-- DO NOT APPLY UNTIL ALL OF:
--   1. The one-time import has run against production with --apply and reported no failures:
--        python scripts/import_blocks.py --social-url https://<social> --campus-db "$CAMPUS_DATABASE_URL" --apply
--      (squirrel-social-profile-social-fixed/social-backend/scripts/import_blocks.py)
--   2. squirrel-campus and squirrel-campus-worker have run with LEGACY_LOCAL_BLOCKS=0 for at least one
--      release, so no code path reads or writes this table.
--
-- To apply: move this file into migrations/ with the next free number (e.g. 013_drop_local_blocks.sql).
-- The migrator tracks applied files by name, so the number only decides the order.

DROP TABLE IF EXISTS blocks;
