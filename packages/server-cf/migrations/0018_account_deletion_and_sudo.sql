-- Migration number: 0018
-- Account (identity) deletion — Phase 1 (GH #58), and the "sudo mode"
-- step-up that gates it (GitHub-style re-auth for a destructive account
-- action). Two independent pieces of state, both riding existing
-- substrate rather than new tables:
--
-- 1. `sessions.time_sudo` / `sessions.sudo_account_id` — session-scoped,
--    account-precise freshness for a recently-completed step-up re-auth
--    (a `purpose='sudo'` magic-link consumed in this same browser). The
--    account-delete endpoint admits the destructive action only when the
--    calling session was sudo-verified for *that same account* inside the
--    freshness window. Two columns instead of a `sudo_grants` table keeps
--    it precise (a multi-account session that sudo'd for account A must
--    not thereby authorize deleting account B) without new machinery.
--    Both NULL on a fresh session; a normal sign-in never sets them.
--
-- 2. `idx_accounts__djibb_provider_client_id` recreated to exclude
--    soft-deleted rows. The 0005 partial UNIQUE index enforced one
--    djibb-native Account per (lowercased) email via
--    `provider_client_id`, but did NOT exclude `time_deleted`. A Phase-1
--    soft-delete tombstones the row while keeping its
--    `provider_client_id` (= the email), so during the grace window a
--    fresh signup with the same email would collide with the tombstone —
--    "delete" would then also *block* re-registration. Sign-in already
--    ignores tombstoned rows (`GetAccountByEmail`/`GetAccountByGoogleId`
--    filter `time_deleted IS NULL`); this closes the equivalent gap on
--    the *create* path. Google-home rows are still disambiguated by
--    Google's `sub`, so they need no equivalent change.

ALTER TABLE "sessions" ADD COLUMN "time_sudo" INTEGER DEFAULT NULL;
ALTER TABLE "sessions" ADD COLUMN "sudo_account_id" TEXT DEFAULT NULL;

DROP INDEX IF EXISTS idx_accounts__djibb_provider_client_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts__djibb_provider_client_id
    ON accounts(provider_client_id)
    WHERE provider_name = 'djibb' AND time_deleted IS NULL;
