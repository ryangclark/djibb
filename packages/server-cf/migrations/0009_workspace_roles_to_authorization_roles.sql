-- Migration number: 0009
-- ADR 0011 §Step 4: retire `WorkspaceRoleEnum` in favor of
-- `AuthorizationRoleEnum`. The 4-tier workspace vocab (owner / admin /
-- member / viewer) merges into the 7-tier entity vocab.
--
-- Mapping: `'member'` → `'viewer'`. A workspace member historically
-- meant "can access the workspace, read-only, may be granted editor on
-- specific entities" — that's `'viewer'` in the 7-tier vocab, NOT
-- `'editor'`. `'editor'` would silently grant workspace-wide write
-- access to every previously-member account. `'owner'`, `'admin'`, and
-- `'viewer'` already align by name.
--
-- D1 tables carrying the legacy `'member'` string value rewrite in
-- place; idempotent (no-op on rows that have already been migrated).
-- Step 7 will move membership off these tables entirely; this migration
-- just brings the vocabulary into alignment ahead of that move.

UPDATE AccountWorkspace SET role = 'viewer' WHERE role = 'member';
UPDATE workspace_invitations SET role = 'viewer' WHERE role = 'member';
