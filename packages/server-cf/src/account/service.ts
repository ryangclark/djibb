import { ParseError, UnexpectedError } from '@djibb/protocol/errors';
import { AccountSchema, type Account } from '@djibb/protocol/account';
import { newId } from '@djibb/protocol/id';
import { InsertAccountRow } from '../auth/d1';
import { mintPersonalWorkspaceEntity } from '../workspace/service';
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

    await InsertAccountRow(env.DJIBB_AUTH, account);

    // ADR 0011 §Step 7b.1: the personal workspace lives entirely in
    // the DjibbList DO + `workspace_entities` / `entity_memberships`
    // projection. The legacy `workspaces` + `AccountWorkspace` tables
    // were dropped in §7b.6; the DO mint is now the sole source of
    // truth for the workspace, so its failure is fatal.
    //
    // The account row was already committed above. On mint failure
    // we leave the orphan in place rather than rolling back — the
    // account is harmless without a workspace (signup retries will
    // converge via deterministic clientGroupID), and the alarm
    // reconciler (ADR 0007) will not see anything to repair because
    // there's no entity row to drift. The visible failure to the
    // caller is what we want.
    try {
        await mintPersonalWorkspaceEntity(env.DJIBB_LIST, account);
    } catch (err) {
        console.error(
            '`CreateAccount()` personal workspace entity mint failed:',
            err
        );
        throw new UnexpectedError();
    }

    return account;
}


