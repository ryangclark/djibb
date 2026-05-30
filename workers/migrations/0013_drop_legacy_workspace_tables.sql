-- ADR 0011 §Step 7b.6: drop the legacy workspace tables.
--
-- Superseded by:
--   workspaces            -> workspace_entities (0004) + slug (0012)
--   AccountWorkspace      -> entity_memberships (0011)
--   workspace_invitations -> entity_invitations_index (0007) + per-DO
--                            invitation rows inside the entity DO
--
-- src/ no longer reads or writes any of these as of the 7b.x mutator
-- pass; the only remaining references were `DELETE FROM` lines inside
-- the test helper's `resetWorkspaceData`, removed in the same commit.
--
-- We can't just `DROP TABLE workspaces` because `workspace_entities`
-- (0004) still has a `workspace_id TEXT DEFAULT NULL REFERENCES
-- workspaces(id)` foreign key — dropping the parent leaves the FK
-- dangling and the next write to workspace_entities (e.g. catalog
-- emit) blows up with "no such table: workspaces". SQLite has no
-- `ALTER TABLE ... DROP CONSTRAINT`, so we use the standard rebuild
-- pattern: create a new table with the same columns minus the FK,
-- copy data, drop the old table, rename, recreate indexes. Indexes
-- are dropped automatically when the old table is dropped.
--
-- The new workspace_entities columns must match the cumulative shape
-- after migrations 0004 + 0008 (slot) + 0010 (meta) + 0012 (slug).
-- workspace_id stays nullable to preserve anonymous-entity support
-- (see 0004's comment on that column).

CREATE TABLE workspace_entities_new (
    id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT DEFAULT NULL,
    type TEXT NOT NULL,
    name TEXT DEFAULT NULL,
    description TEXT DEFAULT NULL,
    forked_from_id TEXT DEFAULT NULL,
    authorization_rules TEXT NOT NULL,
    time_created INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    time_updated INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    time_deleted INTEGER DEFAULT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    slot TEXT DEFAULT NULL,
    meta TEXT DEFAULT NULL,
    slug TEXT NOT NULL DEFAULT ''
);

INSERT INTO workspace_entities_new (
    id, workspace_id, type, name, description, forked_from_id,
    authorization_rules, time_created, time_updated, time_deleted,
    version, slot, meta, slug
)
SELECT
    id, workspace_id, type, name, description, forked_from_id,
    authorization_rules, time_created, time_updated, time_deleted,
    version, slot, meta, slug
FROM workspace_entities;

DROP TABLE workspace_entities;
ALTER TABLE workspace_entities_new RENAME TO workspace_entities;

-- Recreate indexes from 0004, 0008, 0012 (0010 added no index).
CREATE INDEX idx_workspace_entities__workspace_type_deleted
    ON workspace_entities(workspace_id, type, time_deleted);

CREATE INDEX idx_workspace_entities__forked_from
    ON workspace_entities(forked_from_id);

CREATE INDEX idx_workspace_entities__slot
    ON workspace_entities(slot)
    WHERE slot IS NOT NULL;

CREATE UNIQUE INDEX idx_workspace_entities__type_slug
    ON workspace_entities(type, slug);

-- Now safe to drop the parent + its (no-longer-referenced) children.
-- Drop children first so their FKs to `workspaces` are removed before
-- we drop the parent. Associated indexes go with their tables.
DROP TABLE IF EXISTS workspace_invitations;
DROP TABLE IF EXISTS AccountWorkspace;
DROP TABLE IF EXISTS workspaces;
