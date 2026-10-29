-- 009: removing a buddy (Partner Hunt connection; backend/partners/connect.py). Either person may
-- remove an accepted connection, silently: the row stays, as `removed`, with who removed it and when,
-- so the pair's 30-day cooldown can run from the removal. Non-destructive: one more allowed status and
-- two nullable columns.
ALTER TABLE partner_requests DROP CONSTRAINT IF EXISTS partner_requests_status_check;
ALTER TABLE partner_requests ADD CONSTRAINT partner_requests_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'removed'));
ALTER TABLE partner_requests ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE partner_requests ADD COLUMN IF NOT EXISTS removed_by text;
