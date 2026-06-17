-- Migration number: 0003
-- Phase 2: invitations + usernames.
--
-- 1. Re-add UNIQUE(user_name) on accounts as case-insensitive (NOCASE).
--    SQLite doesn't support altering an existing UNIQUE constraint, so we
--    rebuild via a unique index. The original UNIQUE() is kept (it's a no-op
--    for the lookups since usernames are stored lowercased), but the new
--    NOCASE index is what we actually rely on.
-- 2. Add helper indexes on workspace_invitations to support the queries
--    issued by the invitation service:
--       - list pending invites for a workspace
--       - count an inviter's outstanding invites + recent rate
--       - quick lookup of pending invites for a target email (auto-match
--         on accept; the existing target_email index is unfiltered).

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts__user_name_nocase
    ON accounts(user_name COLLATE NOCASE)
    WHERE user_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_invitations__workspace_status
    ON workspace_invitations(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations__inviter_recent
    ON workspace_invitations(inviter_account_id, workspace_id, time_created);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations__target_email_pending
    ON workspace_invitations(target_email, status)
    WHERE target_email IS NOT NULL;
