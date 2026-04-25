import { env } from 'cloudflare:test';
// Vite's `?raw` import inlines the file at build time. Works in the
// vitest-pool-workers sandbox where Node `fs` isn't available.
import migration0001 from '../../migrations/0001_create_user_and_session_tables.sql?raw';
import migration0002 from '../../migrations/0002_workspaces.sql?raw';

const ALL_MIGRATIONS = [migration0001, migration0002];

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

/** Wipe rows from the workspace-related tables between tests. */
export async function resetWorkspaceData(): Promise<void> {
    await env.DJIBB_AUTH.batch([
        env.DJIBB_AUTH.prepare('DELETE FROM AccountWorkspace'),
        env.DJIBB_AUTH.prepare('DELETE FROM workspace_invitations'),
        env.DJIBB_AUTH.prepare('DELETE FROM workspaces'),
        env.DJIBB_AUTH.prepare('DELETE FROM AccountSession'),
        env.DJIBB_AUTH.prepare('DELETE FROM sessions'),
        env.DJIBB_AUTH.prepare('DELETE FROM AccountList'),
        env.DJIBB_AUTH.prepare('DELETE FROM accounts'),
    ]);
}
