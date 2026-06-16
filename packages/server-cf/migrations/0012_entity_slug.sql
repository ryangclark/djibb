-- Migration number: 0012
-- ADR 0011 §Step 7b.5: slugs return — this time on the entity catalog
-- where the cross-DO uniqueness invariant has somewhere to live.
--
-- Design:
--   - `slug` is per-entity-type-namespaced via UNIQUE(type, slug). A
--     workspace and a list can share the same slug string; routing
--     already disambiguates by URL prefix (/w/, /l/, /t/).
--   - NOT NULL: every entity row has a slug from birth. New entities
--     auto-default slug to the id suffix (the nanoid that already lives
--     after the `<type>/` prefix in the id). User-customized slugs ride
--     on top via `setWorkspaceSlug` (and its preflight, which holds the
--     UNIQUE check before the DO mutator runs).
--   - `''` default exists only to satisfy NOT NULL through the ALTER;
--     the backfill UPDATE below immediately replaces it. D1 / SQLite
--     doesn't support dropping a column default cleanly, so the
--     placeholder stays — it's only ever observable mid-migration.
--   - Existing URL routes (/w/<id-suffix>) keep working unchanged
--     because the backfill makes slug == id-suffix for every existing
--     row. Once 7b.5b lands the slug-only route resolver, suffix and
--     slug are the same string for un-customized entities.

ALTER TABLE workspace_entities ADD COLUMN slug TEXT NOT NULL DEFAULT '';

-- Backfill: id is shaped `<type>/<suffix>`; the suffix becomes the slug.
-- `instr(id, '/')` returns 1-based position of the slash; `+1` skips it.
UPDATE workspace_entities
   SET slug = substr(id, instr(id, '/') + 1)
 WHERE slug = '';

CREATE UNIQUE INDEX idx_workspace_entities__type_slug
    ON workspace_entities(type, slug);
