-- Migration number: 0019
-- Account (identity) deletion — Phase 2 (GH #64): the scheduled hard
-- purge of PII for accounts past their `time_deleted` grace window.
--
-- `accounts.time_purged` is the "already hard-purged" marker. Phase 1
-- soft-deletes by stamping `time_deleted`; Phase 2 scrubs the PII columns
-- in place but *keeps* the row (its `id` is still referenced by authored
-- content and the re-signup uniqueness exclusion). Because the scrub
-- leaves `time_deleted` set, the nightly purge sweep would otherwise
-- re-select the same tombstone every night forever. `time_purged`
-- distinguishes "tombstoned, awaiting purge" from "already purged": the
-- sweep selects `time_deleted IS NOT NULL AND time_deleted < cutoff AND
-- time_purged IS NULL`, and the within-grace restore path only
-- un-tombstones rows that are not yet purged.
--
-- NULL on every existing and future row until the purge sweep stamps it;
-- a normal sign-in / soft-delete never touches it.

ALTER TABLE "accounts" ADD COLUMN "time_purged" INTEGER DEFAULT NULL;
