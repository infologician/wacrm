-- ============================================================
-- 031_lead_status.sql — Smart lead-status reader
--
-- Adds the columns the AI lead-status classifier reads and writes on
-- `contacts`. The classifier runs server-side (webhook after-block +
-- a Vercel Cron sweep), reusing the account's existing bring-your-own
-- AI key exactly like the reply assistant — no schema needed for it
-- beyond these contact columns.
--
-- Columns
--   - lead_status            the classification, constrained to the
--                            same six values the app renders as badges.
--                            Defaults to 'new' so every contact has a
--                            status from creation.
--   - lead_status_reason     short (<=140 char) model rationale, shown
--                            on hover / in the detail view.
--   - lead_status_source     'ai' (classifier) or 'manual' (human
--                            override). The classifier never overwrites
--                            a 'manual' status unless the new signal is
--                            strong (interested / not_interested).
--   - lead_status_updated_at when the status last changed.
--   - last_classified_at     when the classifier last ran for this
--                            contact — the idempotency key. The sweep
--                            re-classifies only when a conversation has
--                            messages newer than this.
--   - interest_track,
--     experience_level,
--     best_callback_time     structured lead attributes the classifier
--                            fills in (blanks only) alongside the status.
--
-- RLS is unchanged: `contacts` is already workspace-scoped via
-- `is_account_member(account_id)` (migration 017). These are plain
-- column additions on that table, so every existing policy covers them.
-- Dashboard writes (human override) go through the RLS-scoped client;
-- the classifier writes through the service-role client (webhook / cron
-- have no auth.uid()), same as the reply assistant.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_status text NOT NULL DEFAULT 'new'
    CHECK (lead_status IN ('new','interested','need_time','pending','not_interested','no_reply'));

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_status_reason text;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_status_source text NOT NULL DEFAULT 'ai'
    CHECK (lead_status_source IN ('ai','manual'));

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_status_updated_at timestamptz;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS last_classified_at timestamptz;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS interest_track text;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS experience_level text;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS best_callback_time text;

-- Filtering the Contacts list by status, and the dashboard "Leads by
-- status" counts, both scan by (account_id, lead_status).
CREATE INDEX IF NOT EXISTS idx_contacts_account_lead_status
  ON contacts(account_id, lead_status);
