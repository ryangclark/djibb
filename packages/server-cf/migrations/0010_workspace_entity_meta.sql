-- Migration number: 0010
-- ADR 0011 §Step 5: add a JSON `meta` column to the entity catalog row.
--
-- Rationale: presentation-y fields (cover image URL, icon emoji, theme
-- color, client-specific prefs, A/B-test flags, …) accrete fast and
-- rarely warrant their own column. The bar for a first-class column is
-- "does the catalog need to filter/sort/index on this, or does
-- auth/security care?" — `slot` clears that bar (find inbox by slot);
-- `image_url` does not. Everything that doesn't clear the bar lives
-- under `meta` as a JSON blob.
--
-- The DO side (`list_elements`) already has a `meta TEXT DEFAULT NULL`
-- column from `InitializeTables`; it has been unused until now. This
-- migration brings the D1 catalog into alignment so the catalog
-- projection round-trips faithfully.
--
-- Stored as TEXT (stringified JSON). Catalog readers JSON.parse on the
-- way out; nullable column distinguishes "never written" from "written
-- and now empty" (the latter writes `null`, not `'{}'`).
--
-- No index. Lookups by meta contents would need SQLite JSON1's
-- `json_extract`; if/when that pattern appears, add a generated
-- column + index then.

ALTER TABLE workspace_entities
    ADD COLUMN meta TEXT DEFAULT NULL;
