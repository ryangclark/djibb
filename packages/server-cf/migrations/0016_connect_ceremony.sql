-- Migration number: 0016
-- Connect-ceremony back half (ADR 0024 §1, §4; GH #28). The interactive
-- ceremonies (OAuth, magic-link) can now terminate by minting an
-- `issued_credentials` bearer token for an off-domain client instead of
-- setting the `djibb-session` cookie. This migration adds the two pieces
-- of state that bridge "user finished an interactive method" to "client
-- exchanges a code for a token":
--
-- 1. `connect_authorization_codes` — the single-use, short-TTL bridge the
--    worker hands back to the client's origin after a successful ceremony.
--    Follows the `magic_link_tokens` (0005) sibling-table pattern: the raw
--    code lives only in the redirect URL; the column is SHA-256(raw), so a
--    DB read cannot replay a live code. Single-use via `time_consumed`,
--    expiring via `time_expires`. The row carries the PKCE `code_challenge`
--    (verified at exchange — public clients, no secrets, ADR 0024 §4), the
--    allowlisted `client_origin` the code was issued to, and the client
--    `label` that becomes the minted credential's label. `bound_entity_id`
--    is reserved (NULL in v1) so an entity-scoped ceremony can ride the
--    same row later without a schema change.
--
-- 2. `magic_link_tokens.connect_*` columns — a magic-link ceremony spans
--    the email hop (request on one device, click on another), so its
--    connect context cannot live in a browser cookie the way OAuth's can.
--    It rides on the token row instead: a `purpose='connect'` token carries
--    its origin/challenge/label here, and the consume handler mints a code
--    from them rather than a session. `purpose='signin'` tokens leave these
--    NULL and are entirely unaffected.

CREATE TABLE IF NOT EXISTS "connect_authorization_codes" (
    "code_hash"       TEXT NOT NULL PRIMARY KEY,
    "account_id"      TEXT NOT NULL,
    "client_origin"   TEXT NOT NULL,
    "code_challenge"  TEXT NOT NULL,
    "label"           TEXT DEFAULT NULL,
    "bound_entity_id" TEXT DEFAULT NULL,
    "time_created"    INTEGER NOT NULL,
    "time_expires"    INTEGER NOT NULL,
    "time_consumed"   INTEGER DEFAULT NULL
);

ALTER TABLE "magic_link_tokens" ADD COLUMN "connect_origin" TEXT DEFAULT NULL;
ALTER TABLE "magic_link_tokens" ADD COLUMN "connect_code_challenge" TEXT DEFAULT NULL;
ALTER TABLE "magic_link_tokens" ADD COLUMN "connect_label" TEXT DEFAULT NULL;
