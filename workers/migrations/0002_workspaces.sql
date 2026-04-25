-- Migration number: 0002
-- Workspaces v1: rebuild `workspaces` to drop UNIQUE(name) and add `slug` + `is_personal`.
-- SQLite doesn't allow dropping a UNIQUE constraint in-place, so we rebuild.
-- No prod data: assume dev D1 is wiped & re-applied (no INSERT SELECT preserved).

DROP TABLE IF EXISTS "AccountWorkspace";
DROP TABLE IF EXISTS "workspaces";

CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT DEFAULT NULL,
    "is_personal" INTEGER NOT NULL DEFAULT 0,
    "flags" TEXT DEFAULT NULL,
    "image" TEXT DEFAULT NULL,
    "time_created" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "time_deleted" INTEGER DEFAULT NULL,
    "time_updated" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (slug)
);
CREATE INDEX idx_workspaces__slug ON workspaces(slug);

CREATE TABLE "AccountWorkspace" (
    "account_id" TEXT NOT NULL REFERENCES accounts(id),
    "workspace_id" TEXT NOT NULL REFERENCES workspaces(id),
    "role" TEXT NOT NULL,
    "permissions" TEXT DEFAULT NULL,
    "time_joined" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, workspace_id)
);
CREATE INDEX idx_accountworkspace__account_id ON AccountWorkspace(account_id);
CREATE INDEX idx_accountworkspace__workspace_id ON AccountWorkspace(workspace_id);

CREATE TABLE "workspace_invitations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_id" TEXT NOT NULL REFERENCES workspaces(id),
    "type" TEXT NOT NULL,
    "target_email" TEXT DEFAULT NULL,
    "target_account_id" TEXT DEFAULT NULL REFERENCES accounts(id),
    "role" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "inviter_account_id" TEXT NOT NULL REFERENCES accounts(id),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "max_uses" INTEGER DEFAULT NULL,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "time_created" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "time_expires" INTEGER NOT NULL,
    "time_accepted" INTEGER DEFAULT NULL,
    UNIQUE (token)
);
CREATE INDEX idx_workspace_invitations__workspace_id ON workspace_invitations(workspace_id);
CREATE INDEX idx_workspace_invitations__token ON workspace_invitations(token);
CREATE INDEX idx_workspace_invitations__target_email ON workspace_invitations(target_email);
CREATE INDEX idx_workspace_invitations__target_account_id ON workspace_invitations(target_account_id);
