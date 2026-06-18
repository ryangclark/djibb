#!/usr/bin/env node
/**
 * `seed-operator` — provision the platform **operator** account in D1.
 *
 * The operator (`OPERATOR_ACCOUNT_ID`, a fixed singleton mirrored from
 * `packages/protocol/src/list/index.ts`) is the one principal allowed to
 * set privileged `initList` fields and to own platform entities (the Seed
 * Pool List, the Blank Templates). `djibb promote` authenticates as it
 * by sending its session token as the `djibb-session` cookie.
 *
 * This script seeds two rows: the operator `accounts` row (idempotent —
 * its id never changes) and a fresh long-lived `sessions` row whose id
 * **is** the bearer token. The token is printed once; store it (e.g. as
 * the `DJIBB_OPERATOR_SESSION` env promote reads). It is the only secret
 * in the operator scheme — the account id is a public constant.
 *
 *   node bin/seed-operator.ts                 # print the SQL + a fresh token (dry run)
 *   node bin/seed-operator.ts --execute --local    # run it against the local D1
 *   node bin/seed-operator.ts --execute --remote    # run it against prod D1
 *   node bin/seed-operator.ts --rotate --execute --remote   # invalidate prior operator tokens first
 *
 * Pure + dependency-free like `djibb.ts`; runs under plain `node` via
 * TypeScript type-stripping (Node >= 23.6), no build step.
 */

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const c = {
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};
const PASS = c.green('✓');

/**
 * Mirrors `OPERATOR_ACCOUNT_ID` in `packages/protocol/src/list/index.ts`.
 * Kept as a literal (not imported) for the same reason `djibb.ts`
 * re-derives `SEED_POOL_LIST_ID`: Node's type-stripping can't follow the
 * protocol package's import resolution. Must stay in sync with the source
 * of truth there.
 */
const OPERATOR_ACCOUNT_ID = 'a/djibb';
/** D1 binding's database name (see packages/server-cf/wrangler.toml). */
const D1_DATABASE = 'djibb-auth';

/** url-safe 64-char alphabet, matching `@djibb/protocol` id. */
const URLSAFE =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Mirrors `ID_LENGTH` so the session id looks like any `newId('session')`. */
const ID_SUFFIX_LEN = 21;

/** A fresh url-safe random suffix (cryptographically random). */
function randomSuffix(): string {
    const bytes = randomBytes(ID_SUFFIX_LEN);
    let out = '';
    for (let i = 0; i < ID_SUFFIX_LEN; i++) out += URLSAFE[bytes[i]! % 64];
    return out;
}

/**
 * Build the seed SQL. Idempotent on the account (INSERT OR IGNORE — the
 * id is stable forever); always inserts a *new* session row, since the
 * session id is a fresh secret each run. `--rotate` first deletes any
 * existing operator sessions so prior tokens stop validating.
 */
function buildSql(sessionId: string, rotate: boolean): string {
    const lines: string[] = [];

    // Stable operator account. Epoch-int timestamps — SessionSchema /
    // AccountSchema do `new Date(value * 1000)`, so a string default
    // (CURRENT_TIMESTAMP) would break parse on the auth hot path.
    lines.push(
        `INSERT OR IGNORE INTO accounts ` +
            `(id, display_name, email, email_verified, provider_name, provider_client_id, time_created, time_updated, user_name) ` +
            `VALUES ('${OPERATOR_ACCOUNT_ID}', 'djibb', 'operator@djibb.internal', 1, 'djibb', 'operator', unixepoch(), unixepoch(), 'djibb-operator');`
    );

    if (rotate) {
        // Drop prior operator sessions (and their relationships) so old
        // tokens stop authenticating. The account row is preserved.
        //
        // FK order matters: `AccountSession.session_id REFERENCES
        // sessions(id)` with no ON DELETE CASCADE, so the child
        // (AccountSession) must be deleted before the parent (sessions).
        // We can't use a temp table to remember the ids — D1's importer
        // forbids `CREATE TEMP TABLE` (SQLITE_AUTH). Instead we delete the
        // child link first, then sweep the *orphaned* sessions that carry
        // the operator's distinctive far-future expiry (only operator
        // sessions use unixepoch('2100-01-01'), so user sessions are never
        // touched; the NOT IN guard is belt-and-suspenders).
        lines.push(
            `DELETE FROM AccountSession WHERE account_id = '${OPERATOR_ACCOUNT_ID}';`
        );
        lines.push(
            `DELETE FROM sessions ` +
                `WHERE time_expires = unixepoch('2100-01-01') ` +
                `AND id NOT IN (SELECT session_id FROM AccountSession);`
        );
    }

    // Long-lived session: far-future expiry so ValidateSession() never
    // expires-and-deletes it. ip_country is NOT NULL; 'XX' = unknown.
    lines.push(
        `INSERT INTO sessions (id, ip_country, time_created, time_expires) ` +
            `VALUES ('${sessionId}', 'XX', unixepoch(), unixepoch('2100-01-01'));`
    );
    lines.push(
        `INSERT INTO AccountSession (account_id, session_id) ` +
            `VALUES ('${OPERATOR_ACCOUNT_ID}', '${sessionId}');`
    );

    return lines.join('\n');
}

function main(): number {
    const args = process.argv.slice(2);
    const execute = args.includes('--execute');
    const rotate = args.includes('--rotate');
    const local = args.includes('--local');
    const remote = args.includes('--remote');

    if (execute && local === remote) {
        console.error(
            c.red('with --execute, pass exactly one of --local or --remote')
        );
        return 1;
    }

    const sessionId = `session/${randomSuffix()}`;
    const sql = buildSql(sessionId, rotate);

    console.log(c.bold('seed-operator') + c.dim(` — ${OPERATOR_ACCOUNT_ID}`));
    console.log(c.dim('\n── SQL ──'));
    console.log(sql.replace(/^/gm, '  '));

    if (execute) {
        // wrangler resolves the D1 binding from packages/server-cf/
        // wrangler.toml, so run from the package root (this script is
        // packages/server-cf/bin/...).
        const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        const sqlFile = join(tmpdir(), `djibb-seed-operator-${Date.now()}.sql`);
        writeFileSync(sqlFile, sql + '\n', 'utf8');
        const scope = local ? '--local' : '--remote';
        try {
            execFileSync(
                'npx',
                ['wrangler', 'd1', 'execute', D1_DATABASE, scope, '--file', sqlFile],
                { cwd: serverDir, stdio: 'inherit' }
            );
        } catch (err) {
            console.error(c.red(`\nwrangler execute failed: ${(err as Error).message}`));
            console.error(c.dim('  (is wrangler logged in? is the local D1 migrated?)'));
            return 1;
        }
        console.log(`\n${PASS} operator seeded (${scope.replace('--', '')})`);
    } else {
        console.log(
            c.yellow('\ndry run') +
                c.dim(' — nothing executed. Re-run with --execute --local or --execute --remote.')
        );
    }

    // The token is the secret. Print it last so it's the final thing on
    // screen, with how promote consumes it.
    console.log(c.bold('\n── operator session token (store this secret) ──'));
    console.log(`  ${c.green(sessionId)}`);
    console.log(c.dim('\n  cookie:   djibb-session=' + sessionId));
    console.log(
        c.dim('  promote:  ') +
            `DJIBB_OPERATOR_SESSION=${sessionId} djibb promote --base https://djibb.com`
    );
    if (rotate) {
        console.log(c.yellow('\n  --rotate: prior operator tokens were invalidated.'));
    }
    return 0;
}

process.exit(main());
