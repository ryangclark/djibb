import { OAUTH_PROVIDER } from '../auth/constants';
import { ParseError, UnexpectedError } from '../errors';
import { AccountSchema, type Account } from './index';
import { newId } from '../id';
import {
    buildPersonalWorkspaceStatements,
    mintPersonalWorkspaceEntity,
} from '../workspace/service';
import type { DjibbList } from '../list/durable_object';

/**
 * Narrow shape of the worker bindings CreateAccount actually needs.
 * Defined locally (rather than imported from `../index`) to dodge the
 * import cycle that would otherwise form via the auth handlers.
 */
export type CreateAccountEnv = {
    DJIBB_AUTH: D1Database;
    DJIBB_LIST: DurableObjectNamespace<DjibbList>;
};

export async function CreateAccount(env: CreateAccountEnv, account: Account) {
    const parseResult = AccountSchema.safeParse(account);

    if (!parseResult.success) {
        console.error('`CreateAccount()` parse error:', parseResult.error);
        throw new ParseError();
    }

    // Set creation values.
    account.id = newId('account');
    account.time_created = new Date();
    account.time_deleted = null;
    account.time_updated = account.time_created;

    const accountInsert = env.DJIBB_AUTH
        .prepare(
            `INSERT INTO accounts (
                id,
                display_name,
                email,
                email_verified,
                flags,
                image,
                provider_name,
                provider_client_id,
                time_created,
                time_updated,
                user_name
            ) VALUES (${new Array(11).fill('?').join(', ')})`
        )
        .bind(
            account.id,
            account.display_name,
            account.email,
            account.email_verified,
            account.flags,
            account.image,
            account.provider_name,
            account.provider_client_id,
            Math.floor(account.time_created.getTime() / 1000),
            Math.floor(account.time_updated.getTime() / 1000),
            account.user_name
        );

    const personal = buildPersonalWorkspaceStatements(env.DJIBB_AUTH, account);

    try {
        await env.DJIBB_AUTH.batch([accountInsert, ...personal.statements]);
    } catch (err) {
        console.error('`CreateAccount()` batch error:', err);
        throw new UnexpectedError();
    }

    // ADR 0011 §Step 6: dual-write the personal workspace as a
    // DjibbList entity DO. The legacy `workspaces`/`AccountWorkspace`
    // rows above still satisfy the existing read paths (workspace_app,
    // members API, etc.); step 7 will switch reads to this entity and
    // step 11's cleanup migration will drop the legacy tables.
    //
    // The entity's id matches `personal.workspace.id`, so when step 7
    // collapses the two, the workspace_id readers already point at the
    // right entity DO. `slot: 'personal_workspace'` tags it as the
    // singleton; the invariant (one per account) is enforced here at
    // the call site, not in the mutator.
    //
    // Non-fatal on failure: signup must not break if the entity mint
    // races a cold DO instance. A reconciliation sweeper (ADR 0007's
    // pattern) can backfill missing entity rows from legacy
    // `workspaces` until step 11 drops the legacy table.
    try {
        await mintPersonalWorkspaceEntity(env.DJIBB_LIST, {
            accountId: account.id,
            workspaceId: personal.workspace.id,
            name: personal.workspace.name ?? 'Personal',
        });
    } catch (err) {
        console.error(
            '`CreateAccount()` personal workspace entity mint failed (non-fatal):',
            err
        );
    }

    return account;
}

export async function GetAccountById(d1: D1Database, id: string) {
    return d1
        .prepare(`SELECT * FROM accounts WHERE id = ? LIMIT 1;`)
        .bind(id)
        .first()
        .catch(err => {
            console.error('`GetAccountByID()` query error:', err);
            throw new UnexpectedError();
        })
        .then(shape_AccountRow);
}

/**
 * Look up an Account by its canonical email (case-insensitive).
 *
 * Used by both the magic-link consume path and the OAuth callback's
 * email-match-first resolution (ADR 0010 option C). The Account's
 * `email` column is the matching key; provider tag and Account ID
 * are not consulted here.
 *
 * NOTE: assumes one email per Account at v1 (see CONTEXT.md, the
 * "One verified email per Account at v1" note). When that lifts via
 * a future `account_emails` sibling table, this function moves to
 * joining through that table — and that's the only place that needs
 * to change.
 */
export async function GetAccountByEmail(
    d1: D1Database,
    email: string
): Promise<Account | null> {
    if (!email) {
        throw new Error('`GetAccountByEmail()` error: empty email!');
    }

    return d1
        .prepare(
            `SELECT *
            FROM accounts
            WHERE LOWER(email) = LOWER(?)
                AND time_deleted IS NULL
            LIMIT 1;`
        )
        .bind(email)
        .first()
        .catch(err => {
            console.error('`GetAccountByEmail()` query error:', err);
            throw err;
        })
        .then(shape_AccountRow);
}

export async function GetAccountByGoogleId(
    d1: D1Database,
    providerClientId: string
): Promise<Account | null> {
    if (!providerClientId) {
        throw new Error(
            '`GetAccountByGoogleId()` error: invalid `providerClientId`!'
        );
    }

    return d1
        .prepare(
            `SELECT *
            FROM accounts
            WHERE provider_name = ?
                AND provider_client_id = ?
            LIMIT 1;`
        )
        .bind(OAUTH_PROVIDER.enum.google, providerClientId)
        .first()
        .catch(err => {
            console.error('`GetAccountByGoogleId()` query error:', err);
            throw err;
        })
        .then(shape_AccountRow);
}

function shape_AccountRow(row: any): Account | null {
    if (!row) return null;

    const account = {
        id: row.id,
        display_name: row.display_name,
        email: row.email,
        email_verified: row.email_verified,
        flags: row.flags ? JSON.parse(row.flags) : null,
        image: row.image,
        provider_name: row.provider_name,
        provider_client_id: row.provider_client_id,
        time_created: new Date(row.time_created * 1000),
        time_deleted: row.account_time_deleted
            ? new Date(row.account_time_deleted * 1000)
            : null,
        time_updated: new Date(row.time_updated * 1000),
        user_name: row.user_name,
    };

    // Parse via zod to help ensure nothing's broken/omitted in shaping.
    const parseResult = AccountSchema.safeParse(account);

    if (!parseResult.success) {
        console.error(
            '`shape_AccountRow()` parse error:',
            parseResult.error.format(),
            'row:',
            row
        );

        throw new ParseError();
    }

    return parseResult.data;
}
