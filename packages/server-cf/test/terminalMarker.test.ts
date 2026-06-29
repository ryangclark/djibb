// ADR 0023 §4 / issue #17: the `terminal` marker for irreversible
// mutators, and the dispatch guard it powers. Three surfaces:
//
//   1. Registry invariants (pure) — every TERMINAL_MUTATORS entry is a
//      real mutator; every NON-terminal mutator declares an `inverse`;
//      terminal mutators opt out of the undo path (`inverse` → null).
//   2. Type-level — a module missing `inverse` does not satisfy the
//      `MutatorModule` contract (compile error), which is what keeps
//      "ordinary mutator ⇒ has an inverse" structural (ADR 0005).
//   3. Dispatch guard — a terminal mutator is refused when an acting
//      bearer credential is present (non-interactive client), and is
//      unaffected for interactive sessions; a non-terminal mutator is
//      never blocked by the guard.

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';
import { z } from 'zod';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '@djibb/protocol/id';
import type { AuthorizationRules } from '@djibb/protocol/auth/rules';
import {
    Mutations,
    TERMINAL_MUTATORS,
    isTerminal,
} from '@djibb/protocol/list/mutators';
import type { MutatorModule } from '@djibb/protocol/list/mutators/_shared';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

// ---------- 1. Registry invariants (pure) ----------

describe('terminal marker — registry invariants', () => {
    it('every TERMINAL_MUTATORS entry is a real mutator (auditable set)', () => {
        for (const name of TERMINAL_MUTATORS) {
            expect(Mutations).toHaveProperty(name);
        }
    });

    it('isTerminal agrees with the set membership', () => {
        expect(isTerminal('transferOwnership')).toBe(true);
        expect(isTerminal('renameList')).toBe(false);
        expect(isTerminal('not-a-mutator')).toBe(false);
    });

    it('every non-terminal mutator declares an `inverse` (ADR 0005)', () => {
        // The structural guarantee: an ordinary mutator cannot ship
        // without an inverse. Enforced at compile time by the
        // `MutatorModule` contract + the registry's `satisfies` clause;
        // asserted here at the value level so a regression is caught
        // even if the type ever loosens.
        for (const [name, mod] of Object.entries(Mutations)) {
            if (isTerminal(name)) continue;
            expect(
                typeof (mod as { inverse?: unknown }).inverse,
                `mutator "${name}" must declare an inverse`
            ).toBe('function');
        }
    });

    it('terminal mutators sit outside the undo path (inverse → null)', () => {
        // A terminal mutator is irreversible: its inverse must not place
        // anything on the undo stack. (It still exports `inverse` to
        // satisfy the module contract — returning null is the documented
        // "intentionally not undoable" signal.)
        for (const name of TERMINAL_MUTATORS) {
            const mod = Mutations[name as keyof typeof Mutations] as {
                inverse: (args: unknown) => unknown;
            };
            expect(mod.inverse({})).toBeNull();
        }
    });
});

// ---------- 2. Type-level: missing `inverse` fails to compile ----------

describe('terminal marker — type-level inverse contract', () => {
    it('a module without `inverse` does not satisfy MutatorModule', () => {
        const withInverse: MutatorModule<Record<string, never>> = {
            name: 'x',
            requiredRole: [],
            argsSchema: z.object({}),
            server: () => undefined,
            client: async () => undefined,
            inverse: () => null,
        };
        expect(withInverse.name).toBe('x');

        // The structural guarantee from ADR 0005: omitting `inverse`
        // must be a compile error. The `@ts-expect-error` sits directly
        // on the object literal where tsc reports the missing property;
        // if a future change ever makes `inverse` optional, this line
        // stops erroring and the now-unused directive fails the
        // typecheck — surfacing the regression.
        // @ts-expect-error — `inverse` is required (ADR 0005)
        const missingInverse: MutatorModule<Record<string, never>> = {
            name: 'y',
            requiredRole: [],
            argsSchema: z.object({}),
            server: () => undefined,
            client: async () => undefined,
        };
        void missingInverse;
    });
});

// ---------- DO round-trip helpers (mirror transferOwnership.test.ts) ----------

function getListStub(suffix: string) {
    const prefixed = `${IdTypes.list}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makePush<TBody extends Record<string, unknown>>({
    clientGroupID,
    clientID,
    name,
    mutationId,
    body,
    accountId = null,
}: {
    clientGroupID: string;
    clientID: string;
    name: string;
    mutationId: number;
    body: TBody;
    accountId?: string | null;
}): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID,
                id: mutationId,
                name,
                timestamp: Date.now(),
                args: {
                    accountId,
                    timestamp_client: new Date().toISOString(),
                    ...body,
                } as any,
            },
        ],
    };
}

function makeInitListPush({
    clientGroupID,
    clientID,
    listId,
    accountId,
}: {
    clientGroupID: string;
    clientID: string;
    listId: string;
    accountId: string;
}): PushRequestV1 {
    return {
        profileID: 'p_test',
        clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID,
                id: 1,
                name: 'initList',
                timestamp: Date.now(),
                args: {
                    accountId,
                    listId,
                    timestamp_client: new Date().toISOString(),
                    workspaceId: null,
                } as any,
            },
        ],
    };
}

async function readRules(stub: DurableObjectStub<DjibbList>, listId: string) {
    return runInDurableObject(stub, async (_i, state) => {
        const row = state.storage.sql
            .exec(
                `SELECT authorization_rules FROM list_elements WHERE id = ?;`,
                listId
            )
            .one();
        return JSON.parse(
            row.authorization_rules as string
        ) as AuthorizationRules;
    });
}

async function readName(stub: DurableObjectStub<DjibbList>, listId: string) {
    return runInDurableObject(stub, async (_i, state) => {
        const row = state.storage.sql
            .exec(`SELECT name FROM list_elements WHERE id = ?;`, listId)
            .one();
        return row.name as string;
    });
}

/** Init a list owned by `ownerA` with `targetB` added as an editor —
 *  the shared setup for transfer-ownership cases (recipient must be a
 *  member). Returns the stub + ids and the next free mutation id. */
async function initOwnedListWithMember(suffix: string) {
    const { listId, stub } = getListStub(suffix);
    const clientGroupID = `cg_${suffix}`;
    const clientID = `c_${suffix}`;
    const ownerA = newId('account');
    const targetB = newId('account');

    await stub.handlePush({
        authorizedAccounts: [{ id: ownerA } as any],
        authorizedRole: 'ownerless',
        listId,
        pushRequest: makeInitListPush({
            clientGroupID,
            clientID,
            listId,
            accountId: ownerA,
        }),
    });
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerA } as any],
        authorizedRole: 'owner',
        listId,
        pushRequest: makePush({
            clientGroupID,
            clientID,
            name: 'changeMemberRole',
            mutationId: 2,
            accountId: ownerA,
            body: { listId, targetAccountId: targetB, role: 'editor' },
        }),
    });

    return { listId, stub, clientGroupID, clientID, ownerA, targetB };
}

// ---------- 3. Dispatch guard ----------

describe('terminal marker — dispatch guard', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('refuses a terminal mutator from a bearer-credential client', async () => {
        const { listId, stub, clientGroupID, clientID, ownerA, targetB } =
            await initOwnedListWithMember('term_blocked');

        // A is the owner and caller — role + identity gates pass — but
        // the request acts through an issued bearer credential, so the
        // terminal guard must refuse it.
        const result = await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId,
            actingCredentialId: newId('credential'),
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'transferOwnership',
                mutationId: 3,
                accountId: ownerA,
                body: { listId, toAccountId: targetB },
            }),
        });
        // Skip-and-ack: the push succeeds at the transport layer (no
        // error), but ownership is unchanged.
        expect(result.error).toBeNull();

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]?.role).toBe('owner');
        expect(after.authorized_accounts[targetB]?.role).toBe('editor');
    });

    it('allows the same terminal mutator from an interactive session', async () => {
        const { listId, stub, clientGroupID, clientID, ownerA, targetB } =
            await initOwnedListWithMember('term_allowed');

        // No acting credential id (default null) ⇒ interactive session.
        const result = await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'transferOwnership',
                mutationId: 3,
                accountId: ownerA,
                body: { listId, toAccountId: targetB },
            }),
        });
        expect(result.error).toBeNull();

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]?.role).toBe('admin');
        expect(after.authorized_accounts[targetB]?.role).toBe('owner');
    });

    it('does not block a non-terminal mutator from a bearer client', async () => {
        const { listId, stub } = getListStub('term_nonterminal');
        const clientGroupID = 'cg_term_nonterminal';
        const clientID = 'c_term_nonterminal';
        const ownerA = newId('account');

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID,
                clientID,
                listId,
                accountId: ownerA,
            }),
        });

        // renameList is not terminal, so a bearer credential may run it.
        const result = await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId,
            actingCredentialId: newId('credential'),
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'renameList',
                mutationId: 2,
                accountId: ownerA,
                body: { listId, name: 'Renamed by CLI' },
            }),
        });
        expect(result.error).toBeNull();
        expect(await readName(stub, listId)).toBe('Renamed by CLI');
    });
});
