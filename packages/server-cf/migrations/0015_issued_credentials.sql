-- Migration number: 0015
-- Issued-credentials substrate (ADR 0022 §4). The non-interactive
-- sibling to sessions: where the interactive methods (OAuth, magic-link)
-- mint a multi-account `session`, this table holds pre-issued,
-- single-Account *bearer tokens*. It does NOT replace sessions —
-- `sessions`/`AccountSession` stay in their own substrate, unchanged;
-- a complete "what's connected" view unions both (ADR 0022 §6).
--
-- Follows the sibling-table pattern of `magic_link_tokens` (0005):
--   * `credential_id` is the public handle, safe to display.
--   * `secret_hash` is SHA-256(raw); the raw secret lives only in the
--     issued token, so a DB read alone cannot mint a live credential.
--     Unsalted SHA-256 is acceptable ONLY because tokens are
--     high-entropy random (no dictionary/rainbow surface).
--   * There is deliberately no `kind` column — the client lives in
--     `label`, never in a type enum (ADR 0022 rejected `cli_token`/
--     `email_reply`/`agent` kinds as over-fitting today's clients).
--   * `bound_entity_id` scopes a token to one entity via the id-prefix
--     convention (`l/`, `w/`, `a/`, …). NULL = usable wherever the
--     Account has access. It is carried forward from the request→Account
--     seam but enforced later at the per-entity authz check (the entity
--     isn't in scope at the seam — ADR 0022 §Negative consequences).
--   * `time_revoked`/`time_expires` are soft state: revoked/expired rows
--     are retained (never hard-deleted except on account/cascade delete)
--     so a client can render credential history.
--   * `time_last_used` is best-effort/throttled — never written
--     synchronously per request (hot path).

CREATE TABLE IF NOT EXISTS "issued_credentials" (
    "credential_id"   TEXT NOT NULL PRIMARY KEY,
    "secret_hash"     TEXT NOT NULL,
    "account_id"      TEXT NOT NULL,
    "label"           TEXT DEFAULT NULL,
    "bound_entity_id" TEXT DEFAULT NULL,
    "time_created"    INTEGER NOT NULL,
    "time_last_used"  INTEGER DEFAULT NULL,
    "time_expires"    INTEGER DEFAULT NULL,
    "time_revoked"    INTEGER DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_creds__by_account
    ON issued_credentials(account_id);
