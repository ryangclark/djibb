import { env } from 'cloudflare:test';
// Vite's `?raw` import inlines the file at build time. Works in the
// vitest-pool-workers sandbox where Node `fs` isn't available.
import migration0001 from '../../migrations/0001_create_user_and_session_tables.sql?raw';
import migration0002 from '../../migrations/0002_workspaces.sql?raw';
import migration0003 from '../../migrations/0003_invitations_and_usernames.sql?raw';
import migration0004 from '../../migrations/0004_workspace_entities.sql?raw';
import migration0005 from '../../migrations/0005_magic_link_tokens.sql?raw';
import migration0006 from '../../migrations/0006_magic_link_ip_index.sql?raw';
import migration0007 from '../../migrations/0007_entity_invitations_index.sql?raw';

const ALL_MIGRATIONS = [
    migration0001,
    migration0002,
    migration0003,
    migration0004,
    migration0005,
    migration0006,
    migration0007,
];

function splitStatements(sql: string): string[] {
    // Strip line comments first (they confuse D1's `exec` parser).
    const stripped = sql
        .split('\n')
        .map(line => line.replace(/--.*$/, ''))
        .join('\n');
    return stripped
        .split(/;\s*(?:\n|$)/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

let applied = false;

export async function ensureD1Schema(): Promise<void> {
    if (applied) return;
    applied = true;
    for (const sql of ALL_MIGRATIONS) {
        for (const stmt of splitStatements(sql)) {
            try {
                await env.DJIBB_AUTH.exec(stmt.replace(/\n/g, ' '));
            } catch (err) {
                console.error('migration stmt failed:', stmt, err);
                throw err;
            }
        }
    }
}

/**
 * Run `fn` with the `workspace_entities` table dropped, so any UPSERT
 * against it inside `fn` throws a SQL error. Used to exercise alarm
 * retry-on-failure paths (ADR 0007). The table is recreated from the
 * migration on the way out, even on throw.
 */
export async function withMissingEntitiesTable<T>(
    fn: () => Promise<T>,
): Promise<T> {
    await env.DJIBB_AUTH.exec('DROP TABLE IF EXISTS workspace_entities');
    try {
        return await fn();
    } finally {
        for (const stmt of splitStatements(migration0004)) {
            await env.DJIBB_AUTH.exec(stmt.replace(/\n/g, ' '));
        }
    }
}

/** Wipe rows from the workspace-related tables between tests. */
export async function resetWorkspaceData(): Promise<void> {
    await env.DJIBB_AUTH.batch([
        env.DJIBB_AUTH.prepare('DELETE FROM workspace_entities'),
        env.DJIBB_AUTH.prepare('DELETE FROM AccountWorkspace'),
        env.DJIBB_AUTH.prepare('DELETE FROM workspace_invitations'),
        env.DJIBB_AUTH.prepare('DELETE FROM workspaces'),
        env.DJIBB_AUTH.prepare('DELETE FROM AccountSession'),
        env.DJIBB_AUTH.prepare('DELETE FROM sessions'),
        env.DJIBB_AUTH.prepare('DELETE FROM AccountList'),
        env.DJIBB_AUTH.prepare('DELETE FROM magic_link_tokens'),
        env.DJIBB_AUTH.prepare('DELETE FROM entity_invitations_index'),
        env.DJIBB_AUTH.prepare('DELETE FROM accounts'),
    ]);
}
