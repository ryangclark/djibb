-- Migration number: 0001
CREATE TABLE IF NOT EXISTS "accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    -- could convince me that this should be nullable, but I want to prompt you to seriously consider the UX of having a nameless account.
    "display_name" TEXT NOT NULL,
    "email" TEXT DEFAULT NULL,
    "email_verified" INTEGER DEFAULT 0,
    "flags" TEXT DEFAULT NULL,
    "image" TEXT DEFAULT NULL,
    "provider_name" TEXT NOT NULL,
    "provider_client_id" TEXT NOT NULL,
    "time_created" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "time_deleted" INTEGER DEFAULT NULL,
    "time_updated" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_name" TEXT DEFAULT NULL,
    UNIQUE (user_name)
);
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "flags" TEXT DEFAULT NULL,
    "ip_country" TEXT NOT NULL,
    "time_created" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "time_expires" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "AccountList" (
    "account_id" TEXT NOT NULL REFERENCES accounts(id),
    "list_id" TEXT NOT NULL,
    PRIMARY KEY (account_id, list_id)
);
CREATE INDEX IF NOT EXISTS idx_accountlist__account_id on AccountList(account_id);
CREATE INDEX IF NOT EXISTS idx_accountlist__list_id on AccountList(list_id);
CREATE TABLE IF NOT EXISTS "AccountSession" (
    "account_id" TEXT NOT NULL REFERENCES accounts(id),
    "session_id" TEXT NOT NULL REFERENCES sessions(id),
    PRIMARY KEY (account_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_accountsession__account_id on AccountSession(account_id);
CREATE INDEX IF NOT EXISTS idx_accountsession__session_id on AccountSession(session_id);
CREATE TABLE IF NOT EXISTS "workspaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    -- could convince me that this should be nullable, but I want to prompt you to seriously consider the UX of having a nameless account.
    "name" TEXT NOT NULL,
    "flags" TEXT DEFAULT NULL,
    "image" TEXT DEFAULT NULL,
    "time_created" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "time_deleted" INTEGER DEFAULT NULL,
    "time_updated" INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (name)
);
CREATE TABLE IF NOT EXISTS "AccountWorkspace" (
    "account_id" TEXT NOT NULL REFERENCES accounts(id),
    "permissions" TEXT DEFAULT NULL,
    "role" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL REFERENCES workspaces(id),
    PRIMARY KEY (account_id, workspace_id)
);