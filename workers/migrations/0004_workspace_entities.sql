-- Migration number: 0004
-- ADR 0001: entity metadata in D1 with DO mirror.
-- One row per List or Template. DO keeps a kv mirror; D1 is authoritative.

CREATE TABLE "workspace_entities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    -- `workspace_id` is nullable to support anonymous entity creation
    -- (no session, no workspace target). Tightening to NOT NULL would
    -- be a breaking schema change once we require workspace ownership.
    "workspace_id" TEXT DEFAULT NULL REFERENCES workspaces(id),
    "type" TEXT NOT NULL,
    "name" TEXT DEFAULT NULL,
    "description" TEXT DEFAULT NULL,
    "forked_from_id" TEXT DEFAULT NULL,
    "authorization_rules" TEXT NOT NULL,
    "time_created" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "time_updated" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "time_deleted" INTEGER DEFAULT NULL,
    "version" INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_workspace_entities__workspace_type_deleted
    ON workspace_entities(workspace_id, type, time_deleted);

CREATE INDEX idx_workspace_entities__forked_from
    ON workspace_entities(forked_from_id);
