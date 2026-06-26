#!/usr/bin/env node
/**
 * `seed-operator` — provision the platform **operator** account in D1.
 *
 * The operator (`OPERATOR_ACCOUNT_ID`, a fixed singleton mirrored from
 * `packages/protocol/src/list/index.ts`) is the one principal allowed to
 * set privileged `initList` fields and to own platform entities (the Seed
 * Pool List, the Blank Templates). `djibb promote` authenticates as it
 * by sending an issued-credential **bearer token** in the
 * `Authorization` header (ADR 0022).
 *
 * This script seeds two rows: the operator `accounts` row (idempotent —
 * its id never changes) and a fresh `issued_credentials` row — the
 * non-interactive, single-Account, revocable API key of ADR 0022 §4. The
 * printed token is `<credential_id>.<secret>`; only `SHA-256(secret)` is
 * stored, so a DB read can't reconstruct it. Store the token once (e.g.
 * as the `DJIBB_CLI_TOKEN` env promote reads). It is the only secret in
 * the operator scheme — the account id is a public constant.
 *
 *   node bin/seed-operator.ts                 # print the SQL + a fresh token (dry run)
 *   node bin/seed-operator.ts --execute --local    # run it against the local D1
 *   node bin/seed-operator.ts --execute --remote    # run it against prod D1
 *   node bin/seed-operator.ts --rotate --execute --remote   # revoke prior operator tokens first
 *
 * Pure + dependency-free like `djibb.ts`; runs under plain `node` via
 * TypeScript type-stripping (Node >= 23.6), no build step.
 */

import { createHash, randomBytes } from 'node:crypto';
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
/** Mirrors `ID_LENGTH` so the credential id looks like any `newId('credential')`. */
const ID_SUFFIX_LEN = 21;
/**
 * Mirrors `SECRET_LENGTH` in `src/auth/credential.ts`: 43 url-safe chars
 * ≈ 258 bits of entropy — the threshold that makes unsalted SHA-256
 * storage safe. Must stay in sync; `VerifyBearerCredential` length-gates
 * the secret on it.
 */
const SECRET_LEN = 43;

/** A fresh url-safe random string of `len` chars (cryptographically random). */
function randomUrlSafe(len: number): string {
    const bytes = randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += URLSAFE[bytes[i]! % 64];
    return out;
}

/** SHA-256(raw) as lowercase hex — mirrors `hashSecret` in credential.ts. */
function sha256Hex(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Build the seed SQL. Idempotent on the account (INSERT OR IGNORE — the
 * id is stable forever); always inserts a *new* `issued_credentials` row,
 * since the secret is fresh each run. `--rotate` first revokes any
 * existing (non-revoked) operator credentials so prior tokens stop
 * authenticating — soft state, not a hard delete (ADR 0022 §4 retains
 * revoked rows for credential history).
 */
function buildSql(
    credentialId: string,
    secretHash: string,
    rotate: boolean
): string {
    const lines: string[] = [];

    // Stable operator account. Epoch-int timestamps — AccountSchema does
    // `new Date(value * 1000)`, so a string default (CURRENT_TIMESTAMP)
    // would break parse on the auth hot path.
    lines.push(
        `INSERT OR IGNORE INTO accounts ` +
            `(id, display_name, email, email_verified, provider_name, provider_client_id, time_created, time_updated, user_name) ` +
            `VALUES ('${OPERATOR_ACCOUNT_ID}', 'djibb', 'operator@djibb.internal', 1, 'djibb', 'operator', unixepoch(), unixepoch(), 'djibb-operator');`
    );

    if (rotate) {
        // Revoke prior operator credentials so old tokens stop
        // authenticating (VerifyBearerCredential rejects `time_revoked`).
        // Soft state — the rows are kept for history.
        lines.push(
            `UPDATE issued_credentials SET time_revoked = unixepoch() ` +
                `WHERE account_id = '${OPERATOR_ACCOUNT_ID}' AND time_revoked IS NULL;`
        );
    }

    // The operator's CLI API key. Non-expiring (revoke-only); the raw
    // secret never lands here — only its SHA-256.
    lines.push(
        `INSERT INTO issued_credentials ` +
            `(credential_id, secret_hash, account_id, label, time_created) ` +
            `VALUES ('${credentialId}', '${secretHash}', '${OPERATOR_ACCOUNT_ID}', 'djibb operator CLI', unixepoch());`
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

    // The bearer token is `<credential_id>.<secret>` (ADR 0022). The
    // credential_id is a public handle; the secret is the only thing that
    // must stay private, and only its SHA-256 is persisted.
    const credentialId = `c/${randomUrlSafe(ID_SUFFIX_LEN)}`;
    const secret = randomUrlSafe(SECRET_LEN);
    const token = `${credentialId}.${secret}`;
    const sql = buildSql(credentialId, sha256Hex(secret), rotate);

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
    console.log(c.bold('\n── operator CLI token (store this secret) ──'));
    console.log(`  ${c.green(token)}`);
    console.log(c.dim('\n  header:   Authorization: Bearer ' + token));
    console.log(
        c.dim('  promote:  ') +
            `DJIBB_CLI_TOKEN=${token} djibb promote --base https://api.djibb.com`
    );
    // Recommended persistent storage on macOS: stash it in the login
    // keychain once and `promote` reads it automatically (env unset). The
    // Passwords app can't be used — its iCloud-keychain entries aren't
    // readable by the `security` CLI. See `operatorToken` in djibb.ts.
    console.log(c.dim('\n  store (macOS, then `djibb promote` finds it with no env):'));
    console.log(
        c.dim('    ') +
            'security add-generic-password -U -a djibb-operator -s DJIBB_CLI_TOKEN -w'
    );
    console.log(c.dim('    (no value after -w → it prompts; paste the token above. Keeps it out of shell history.)'));
    if (rotate) {
        console.log(c.yellow('\n  --rotate: prior operator tokens were revoked.'));
    }
    return 0;
}

process.exit(main());
