-- Migration number: 0005
-- Magic-link authentication substrate (ADR 0010).
--
-- 1. `magic_link_tokens` — D1-resident token store. Raw tokens live
--    only in emailed URLs; the column is SHA-256(raw) so a DB read
--    cannot mint live sessions. Single-use via `time_consumed`,
--    expiring via `time_expires`. `purpose` reserved for future
--    flows (`verify_email_change`, etc.); v1 uses `signin`.
-- 2. `idx_magic__by_email_time` — supports rate-limit reads
--    (count tokens per email over a window) and "any pending token
--    for this email" lookups.
-- 3. `idx_accounts__djibb_provider_client_id` — partial UNIQUE index
--    enforcing one djibb-native Account per (lowercased) email at
--    the schema layer. Google-home Accounts are already disambiguated
--    by Google's `sub` (unique by construction); this index closes
--    the equivalent loophole for djibb-as-IdP rows.

CREATE TABLE IF NOT EXISTS "magic_link_tokens" (
    "token_hash" TEXT NOT NULL PRIMARY KEY,
    "target_email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "time_created" INTEGER NOT NULL,
    "time_expires" INTEGER NOT NULL,
    "time_consumed" INTEGER DEFAULT NULL,
    "request_ip" TEXT DEFAULT NULL,
    "user_agent" TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_magic__by_email_time
    ON magic_link_tokens(target_email, time_created);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts__djibb_provider_client_id
    ON accounts(provider_client_id)
    WHERE provider_name = 'djibb';
