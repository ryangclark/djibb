-- Migration number: 0007
-- ADR 0009: tokenless DO-resident invitations.
--
-- The D1 read index for entity-level (List, Template) invitations.
-- The entity DO is authoritative for pending invites (under its own
-- `pending_invites` table); this D1 table is a derived projection
-- emitted post-commit, used for two read paths the DO can't answer
-- alone:
--
--   1. "What's pending for me?" — lookup by (identity_kind,
--      identity_value, status='pending') across all targets.
--   2. Cross-target per-inviter rate limits — count by
--      inviter_account_id within a time window.
--
-- Accepted invitations are retained as audit (status='accepted',
-- time_accepted populated) and hard-deleted on entity cascade-delete
-- (ADR 0008).
--
-- Identity-kind is generalized for future expansion. v1 only
-- implements 'email'.

CREATE TABLE "entity_invitations_index" (
    "id" TEXT NOT NULL PRIMARY KEY,        -- 'inv/<suffix>' (see workers/src/id)
    "target_id" TEXT NOT NULL,             -- entity id ('l/<suffix>' | 't/<suffix>')
    "target_type" TEXT NOT NULL,           -- 'list' | 'template' | 'workspace' (future)
    "identity_kind" TEXT NOT NULL,         -- 'email' v1
    "identity_value" TEXT NOT NULL,        -- lowercased for email
    "role" TEXT NOT NULL,                  -- AccountRole granted on accept
    "inviter_account_id" TEXT NOT NULL,    -- 'a/<suffix>'
    "status" TEXT NOT NULL,                -- 'pending' | 'accepted' | 'revoked' | 'expired'
    "time_created" INTEGER NOT NULL,
    "time_expires" INTEGER NOT NULL,
    "time_accepted" INTEGER DEFAULT NULL
);

-- Partial UNIQUE: at most one pending invite per (target, identity).
-- Accepted/revoked rows are audit history and may coexist with a fresh
-- pending row. Re-inviting an existing member is rejected at the
-- mutator layer ("already a member"), not by this index.
CREATE UNIQUE INDEX idx_invites__pending_unique
    ON entity_invitations_index(target_id, identity_kind, identity_value)
    WHERE status = 'pending';

-- "What's pending for me?" — the canonical /invitations inbox query.
CREATE INDEX idx_invites__by_identity
    ON entity_invitations_index(identity_kind, identity_value, status);

-- Cross-target per-inviter rate limits (ADR 0009 §"Other policy defaults").
CREATE INDEX idx_invites__by_inviter_time
    ON entity_invitations_index(inviter_account_id, time_created);

-- Cascade-delete fast path (ADR 0008): hard-delete all rows for an
-- entity when its DO is torn down.
CREATE INDEX idx_invites__by_target
    ON entity_invitations_index(target_id);
