-- Migration number: 0011
-- ADR 0011 §Step 7 (foundation): introduce the `entity_memberships`
-- D1-side projection of `authorization_rules.authorized_accounts`.
-- Emitted post-commit from the DO (same pattern as
-- `EmitEntitySnapshotToCatalog` per ADR 0003). Indexed on account_id
-- (PK) for the "what entities is this account a member of?" read, and
-- on entity_id for the "who's a member of this entity?" read. Role
-- lives on the row so the auth resolver fast path doesn't have to
-- round-trip to the DO.
--
-- This migration is additive. The legacy `workspaces`, `AccountWorkspace`,
-- and `workspace_invitations` tables stay in place for now so existing
-- read sites keep working; they're dropped in a follow-up migration
-- (0012) once `workspace/service.ts` + `workspace/invitations.ts` +
-- `workspace/fetch.ts` have been gutted and the account-signup flow
-- stops dual-writing into them. Pre-prod (no backfill needed),
-- confirmed with user.

CREATE TABLE "entity_memberships" (
    "account_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "time_updated" INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_id, entity_id)
);
CREATE INDEX idx_entity_memberships__entity_id
    ON entity_memberships(entity_id);
