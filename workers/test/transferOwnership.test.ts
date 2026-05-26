// ADR 0011 §Decision C: tests for `transferOwnership` and the
// single-owner invariant helpers. Two surfaces:
//   1. Pure helpers (`countOwners`, `findOwnerAccountId`,
//      `assertSingleOwner`) — fast, no DO.
//   2. `DjibbList.handlePush` round-trips for the mutator's end-state
//      (DO sql `list_elements.authorization_rules`).

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import type { AuthorizationRules } from '../src/auth/rules';
import {
    assertSingleOwner,
    countOwners,
    findOwnerAccountId,
    SingleOwnerInvariantError,
} from '../src/list/mutators/_shared';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

// ---------- Helpers (DO round-trip pattern; mirrors acceptInvitation.test.ts) ----------

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
                listId,
            )
            .one();
        return JSON.parse(row.authorization_rules as string) as AuthorizationRules;
    });
}

// ---------- Pure helpers ----------

describe('single-owner invariant helpers', () => {
    function rules(
        accounts: Record<string, AuthorizationRules['authorized_accounts'][string]>,
    ): AuthorizationRules {
        return {
            authorized_accounts: accounts,
            default_role: 'restricted',
            set_by: 'user',
        };
    }

    it('countOwners counts the `owner` role', () => {
        expect(countOwners(rules({}))).toBe(0);
        expect(
            countOwners(
                rules({
                    'a/x': { role: 'editor' },
                    'a/y': { role: 'admin' },
                }),
            ),
        ).toBe(0);
        expect(
            countOwners(
                rules({
                    'a/x': { role: 'owner' },
                    'a/y': { role: 'admin' },
                }),
            ),
        ).toBe(1);
        expect(
            countOwners(
                rules({
                    'a/x': { role: 'owner' },
                    'a/y': { role: 'owner' },
                }),
            ),
        ).toBe(2);
    });

    it('findOwnerAccountId returns the unique owner or null', () => {
        expect(findOwnerAccountId(rules({}))).toBe(null);
        expect(
            findOwnerAccountId(
                rules({
                    'a/x': { role: 'owner' },
                    'a/y': { role: 'editor' },
                }),
            ),
        ).toBe('a/x');
    });

    it('findOwnerAccountId throws when invariant is already violated', () => {
        expect(() =>
            findOwnerAccountId(
                rules({
                    'a/x': { role: 'owner' },
                    'a/y': { role: 'owner' },
                }),
            ),
        ).toThrow(SingleOwnerInvariantError);
    });

    it('assertSingleOwner accepts zero or one owner', () => {
        expect(() => assertSingleOwner(rules({}))).not.toThrow();
        expect(() =>
            assertSingleOwner(rules({ 'a/x': { role: 'owner' } })),
        ).not.toThrow();
    });

    it('assertSingleOwner throws on two or more owners', () => {
        expect(() =>
            assertSingleOwner(
                rules({
                    'a/x': { role: 'owner' },
                    'a/y': { role: 'owner' },
                }),
            ),
        ).toThrow(SingleOwnerInvariantError);
    });
});

// ---------- transferOwnership (DO mutator) ----------

describe('transferOwnership (DO mutator)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('swaps owner → admin, target → owner', async () => {
        const { listId, stub } = getListStub('xfer1');
        const clientGroupID = 'cg_xfer_1';
        const clientID = 'c_xfer_1';
        const ownerA = newId('account');
        const targetB = newId('account');

        // Init with an explicit principal owner.
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

        // Sanity: A is owner.
        const before = await readRules(stub, listId);
        expect(before.authorized_accounts[ownerA]?.role).toBe('owner');

        // Transfer from A → B (caller is A).
        const result = await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'transferOwnership',
                mutationId: 2,
                accountId: ownerA,
                body: { listId, toAccountId: targetB },
            }),
        });
        expect(result.error).toBeNull();

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]?.role).toBe('admin');
        expect(after.authorized_accounts[targetB]?.role).toBe('owner');
        // Invariant holds post-swap.
        expect(countOwners(after)).toBe(1);
    });

    it('returns stale when caller is not the current owner', async () => {
        const { listId, stub } = getListStub('xfer2');
        const clientGroupID = 'cg_xfer_2';
        const clientID = 'c_xfer_2';
        const ownerA = newId('account');
        const otherC = newId('account');
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

        // C is not the current owner. The role gate (requiredRole: owner)
        // will reject before we even hit the body's CAS pre-check —
        // dispatch surfaces this as `unauthorized`. Either failure mode
        // means the transfer didn't happen; assert on end-state.
        await stub.handlePush({
            authorizedAccounts: [{ id: otherC } as any],
            authorizedRole: 'editor',
            listId,
            pushRequest: makePush({
                clientGroupID: 'cg_other',
                clientID: 'c_other',
                name: 'transferOwnership',
                mutationId: 1,
                accountId: otherC,
                body: { listId, toAccountId: targetB },
            }),
        });

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]?.role).toBe('owner');
        expect(after.authorized_accounts[targetB]).toBeUndefined();
    });

    it('no-ops on same-target transfer', async () => {
        const { listId, stub } = getListStub('xfer3');
        const clientGroupID = 'cg_xfer_3';
        const clientID = 'c_xfer_3';
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

        const result = await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'transferOwnership',
                mutationId: 2,
                accountId: ownerA,
                body: { listId, toAccountId: ownerA },
            }),
        });
        expect(result.error).toBeNull();

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]?.role).toBe('owner');
        expect(countOwners(after)).toBe(1);
    });

    it('fromAccountId CAS no-ops when current owner differs', async () => {
        const { listId, stub } = getListStub('xfer4');
        const clientGroupID = 'cg_xfer_4';
        const clientID = 'c_xfer_4';
        const ownerA = newId('account');
        const targetB = newId('account');
        const ghostFromZ = newId('account');

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

        // Caller is the real owner A, but the client-supplied `fromAccountId`
        // disagrees (stale local view). Should no-op.
        const result = await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'transferOwnership',
                mutationId: 2,
                accountId: ownerA,
                body: {
                    listId,
                    toAccountId: targetB,
                    fromAccountId: ghostFromZ,
                },
            }),
        });
        expect(result.error).toBeNull();

        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]?.role).toBe('owner');
        expect(after.authorized_accounts[targetB]).toBeUndefined();
    });
});
