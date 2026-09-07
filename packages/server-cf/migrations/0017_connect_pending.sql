-- Migration number: 0017
-- Connect-ceremony disclosure interstitial (ADR 0024 §3; GH #29). The #28
-- back half minted the authorization code the instant a ceremony verified
-- the user. §3 requires a worker-owned disclosure — "this connects <client>
-- to your djibb identity", with a real decline path — to sit *between*
-- verification and code issuance: no code (and so no credential) may exist
-- until the user approves on the substrate's own surface.
--
-- `connect_pending` is the state that bridges "ceremony verified + Account
-- resolved" to "user approved on the consent page". It follows the
-- `connect_authorization_codes` (0016) sibling-table pattern exactly: the
-- raw handle lives only in the consent-page URL; the column is
-- SHA-256(raw), so a DB read cannot forge a live consent. Single-use via
-- `time_consumed` (approve OR decline spends it), expiring via
-- `time_expires` (a human has to read + click, so the TTL is a touch longer
-- than a code's). The row carries everything the consent page must show and
-- the approval must mint from:
--
--   * `account_id` / `account_display_name` — who is connecting; the name
--     drives the "welcome, <name>!" greeting. Denormalized here (ephemeral
--     row, ≤ its TTL) so rendering the page is one lookup and never widens
--     into the Account's other data (§3 rule 2).
--   * `client_origin` / `code_challenge` / `label` / `bound_entity_id` —
--     handed straight to `InsertAuthorizationCode` on approve, so the code
--     the client later exchanges carries the same ceremony context #28 built.
--
-- A `signin` ceremony never touches this table; only connect ceremonies do.

CREATE TABLE IF NOT EXISTS "connect_pending" (
    "handle_hash"          TEXT NOT NULL PRIMARY KEY,
    "account_id"           TEXT NOT NULL,
    "account_display_name" TEXT DEFAULT NULL,
    "client_origin"        TEXT NOT NULL,
    "code_challenge"       TEXT NOT NULL,
    "label"                TEXT DEFAULT NULL,
    "bound_entity_id"      TEXT DEFAULT NULL,
    "time_created"         INTEGER NOT NULL,
    "time_expires"         INTEGER NOT NULL,
    "time_consumed"        INTEGER DEFAULT NULL
);
