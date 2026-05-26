-- Migration number: 0008
-- ADR 0011: collapse `is_personal` / `system: true` / future entity-role
-- booleans onto a single nullable `slot` enum column. Null for ordinary
-- user-created entities; specific values (`personal_workspace`, `inbox`,
-- `seed_pool`) tag the well-known singleton entities described in
-- workspaces.md §Slots.

ALTER TABLE workspace_entities
    ADD COLUMN slot TEXT DEFAULT NULL;

-- Lookups by slot are sparse-but-targeted: "find this account's inbox",
-- "find the seed pool", "find this account's personal workspace". A
-- partial index over the non-null rows keeps the index small while
-- making those lookups direct.
CREATE INDEX idx_workspace_entities__slot
    ON workspace_entities(slot)
    WHERE slot IS NOT NULL;
