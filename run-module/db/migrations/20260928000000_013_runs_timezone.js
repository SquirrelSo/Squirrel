/**
 * 013: the phone's time zone on each run.
 *
 * "Which day was this run" (the daily XP cap) is the runner's calendar day, not UTC's and not one
 * server-wide zone: an IANA name (e.g. Asia/Kolkata) sent when the run starts. Null for runs from
 * before, and for clients that do not send one; those fall back to XP_TIMEZONE.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = async (pgm) => {
  pgm.sql("ALTER TABLE runs ADD COLUMN IF NOT EXISTS timezone text;");
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = async (pgm) => {
  pgm.sql("ALTER TABLE runs DROP COLUMN IF EXISTS timezone;");
};
