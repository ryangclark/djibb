-- ADR 0011 §Step 10a.1 / ADR 0008: `cascade_source` projection column.
--
-- When a Workspace is soft-deleted via `softDeleteWorkspace` (ADR 0008),
-- the Workspace DO's alarm dispatcher fans cascade-archive mutations out
-- to each child Workspace's owned Lists and Templates. Each cascade
-- mutation stamps `cascade_source = <workspaceId>` onto the child's
-- entity row and into the emitted catalog snapshot.
--
-- Three uses:
--
--   1. Restore predicate. `restoreWorkspace` finds every entity *this
--      specific deletion* archived via
--      `WHERE cascade_source = ? AND time_deleted IS NOT NULL`. No tree
--      traversal; one indexed scan.
--
--   2. Preserves manual-archive intent. A list the user manually
--      archived *before* the workspace deletion has `cascade_source IS
--      NULL`, so the restore predicate skips it — that earlier choice
--      is independent of "I want my workspace back."
--
--   3. Trash UI grouping (Step 10b). "Show everything that died with
--      this workspace deletion" becomes a clean read, lets the UI
--      group restorable items by deletion event.
--
-- NULL is the resting value for every entity that's never been
-- cascade-archived. The column is set only by cascade-archive
-- mutations and cleared by `restoreWorkspace` (10a.5) via a direct
-- catalog UPDATE.

ALTER TABLE workspace_entities
    ADD COLUMN cascade_source TEXT DEFAULT NULL;

-- Partial index on the non-NULL rows. Cardinality is low even at
-- scale (one workspace deletion produces dozens-to-hundreds of rows;
-- across many deletions, the index stays bounded by total
-- soft-deleted entities). Without the index, the restore predicate
-- would full-scan the catalog every batch tick.
CREATE INDEX idx_workspace_entities__cascade_source
    ON workspace_entities(cascade_source)
    WHERE cascade_source IS NOT NULL;
