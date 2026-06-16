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
import { IdTypes, newId } from '@djibb/protocol/id';
import type { AuthorizationRules } from '../src/auth/rules';
import {
    assertSingleOwner,
    countOwners,
    findOwnerAccountId,
    SingleOwnerInvariantError,
} from '../src/list/mutators/_shared';
import { CreateAccount } from '../src/account/service';
import type { Account } from '../src/account';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

function makeAccount(overrides: Partial<Account> = {}): Account {
    return {
        id: '',
        display_name: 'Test User',
        email: `t-${Math.random().toString(36).slice(2)}@example.com`,
        email_verified: true,
        flags: null,
        image: null,
        provider_name: 'google',
        provider_client_id: 'g-' + Math.random().toString(36).slice(2),
        user_name: null,
        time_created: new Date(),
        time_deleted: null,
        time_updated: new Date(),
        ...overrides,
    } as Account;
}

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

        // B must be a member before ownership can be transferred to them
        // (recipient-must-be-a-member guard). Add B as an editor.
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

        // Transfer from A → B (caller is A).
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

    it('rejects a transfer to a non-member (recipient guard)', async () => {
        const { listId, stub } = getListStub('xfer5');
        const clientGroupID = 'cg_xfer_5';
        const clientID = 'c_xfer_5';
        const ownerA = newId('account');
        const strangerB = newId('account'); // never added as a member

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

        // A is the owner and the caller, so the role + identity gates
        // pass — but B isn't a member, so the recipient guard no-ops it.
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
                body: { listId, toAccountId: strangerB },
            }),
        });
        expect(result.error).toBeNull();

        // Ownership unchanged; the stranger was never added.
        const after = await readRules(stub, listId);
        expect(after.authorized_accounts[ownerA]?.role).toBe('owner');
        expect(after.authorized_accounts[strangerB]).toBeUndefined();
        expect(countOwners(after)).toBe(1);
    });
});

// ---------- transferOwnership confirmation email (ADR 0011 §Decision C, Phase 5) ----------

describe('transferOwnership confirmation email', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    /** Swap `env.EMAIL` for a capturing spy; returns the captured sends
     *  array and a restore fn. Mirrors entityInvitations.test.ts. */
    function spyOnEmail() {
        const sends: Array<Record<string, unknown>> = [];
        const original = (env as { EMAIL?: unknown }).EMAIL;
        (env as { EMAIL: unknown }).EMAIL = {
            send: async (msg: Record<string, unknown>) => {
                sends.push(msg);
            },
        };
        return { sends, restore: () => ((env as { EMAIL: unknown }).EMAIL = original) };
    }

    /** Init list owned by `ownerA`, add `toAccountId` as a member (the
     *  recipient guard requires it — skipped when transferring to self),
     *  then transfer ownership to them. `ownerName` populates the
     *  session's `authorizedAccounts` so the email can name the former
     *  owner. */
    async function initAndTransfer({
        suffix,
        ownerA,
        ownerName,
        ownerEmail,
        toAccountId,
    }: {
        suffix: string;
        ownerA: string;
        ownerName?: string;
        ownerEmail?: string;
        toAccountId: string;
    }) {
        const { listId, stub } = getListStub(suffix);
        const clientGroupID = `cg_${suffix}`;
        const clientID = `c_${suffix}`;
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

        // Recipient must be a member first (unless it's a same-owner
        // no-op). Note this only writes the entity's authorization_rules
        // — it does NOT create a D1 accounts row, so the email lookup
        // can still come up empty (exercised below).
        let nextId = 2;
        if (toAccountId !== ownerA) {
            await stub.handlePush({
                authorizedAccounts: [{ id: ownerA } as any],
                authorizedRole: 'owner',
                listId,
                pushRequest: makePush({
                    clientGroupID,
                    clientID,
                    name: 'changeMemberRole',
                    mutationId: nextId++,
                    accountId: ownerA,
                    body: {
                        listId,
                        targetAccountId: toAccountId,
                        role: 'editor',
                    },
                }),
            });
        }

        const result = await stub.handlePush({
            authorizedAccounts: [
                {
                    id: ownerA,
                    display_name: ownerName,
                    email: ownerEmail,
                } as any,
            ],
            authorizedRole: 'owner',
            listId,
            pushRequest: makePush({
                clientGroupID,
                clientID,
                name: 'transferOwnership',
                mutationId: nextId,
                accountId: ownerA,
                body: { listId, toAccountId },
            }),
        });
        return { listId, result };
    }

    it('emails the new owner, naming the former owner', async () => {
        const ownerA = newId('account');
        const newOwner = await CreateAccount(env, makeAccount());
        const { sends, restore } = spyOnEmail();
        try {
            const { result } = await initAndTransfer({
                suffix: 'mail1',
                ownerA,
                ownerName: 'Alice',
                toAccountId: newOwner.id,
            });
            expect(result.error).toBeNull();

            expect(sends).toHaveLength(1);
            const sent = sends[0]!;
            expect(sent.to).toBe(newOwner.email);
            expect(String(sent.subject).toLowerCase()).toContain('owner');
            // Former owner is named in the body.
            expect(String(sent.html)).toContain('Alice');
            expect(String(sent.text)).toContain('Alice');
            // Link points at the list (not an invite-accept URL).
            expect(String(sent.text)).toContain('/l/');
            expect(String(sent.text)).not.toContain('from_invite');
        } finally {
            restore();
        }
    });

    it('does not email on a same-owner no-op transfer', async () => {
        const ownerA = newId('account');
        const { sends, restore } = spyOnEmail();
        try {
            const { result } = await initAndTransfer({
                suffix: 'mail2',
                ownerA,
                ownerName: 'Alice',
                toAccountId: ownerA, // same as current owner → no-op
            });
            expect(result.error).toBeNull();
            expect(sends).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('skips the send when the new owner has no resolvable email', async () => {
        const ownerA = newId('account');
        // A real-looking account id that was never written to D1, so
        // `GetAccountById` resolves nothing.
        const ghostOwner = newId('account');
        const { sends, restore } = spyOnEmail();
        try {
            const { result } = await initAndTransfer({
                suffix: 'mail3',
                ownerA,
                ownerName: 'Alice',
                toAccountId: ghostOwner,
            });
            // Transfer still committed; only the notification is skipped.
            expect(result.error).toBeNull();
            expect(sends).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('falls back to "Someone" when the former owner has no display name', async () => {
        const ownerA = newId('account');
        const newOwner = await CreateAccount(env, makeAccount());
        const { sends, restore } = spyOnEmail();
        try {
            await initAndTransfer({
                suffix: 'mail4',
                ownerA,
                ownerName: undefined,
                toAccountId: newOwner.id,
            });
            expect(sends).toHaveLength(1);
            expect(String(sends[0]!.text)).toContain('Someone');
        } finally {
            restore();
        }
    });

    it('also emails the former owner a receipt naming the new owner', async () => {
        const ownerA = newId('account');
        const ownerEmail = `alice-${Math.random().toString(36).slice(2)}@example.com`;
        const newOwner = await CreateAccount(
            env,
            makeAccount({ display_name: 'Bob' })
        );
        const { sends, restore } = spyOnEmail();
        try {
            await initAndTransfer({
                suffix: 'mail5',
                ownerA,
                ownerName: 'Alice',
                ownerEmail,
                toAccountId: newOwner.id,
            });

            // Two sends: notification to the new owner + receipt to the
            // former owner.
            expect(sends).toHaveLength(2);
            const notification = sends.find(s => s.to === newOwner.email)!;
            const receipt = sends.find(s => s.to === ownerEmail)!;
            expect(notification).toBeDefined();
            expect(receipt).toBeDefined();

            // Notification names the former owner.
            expect(String(notification.text)).toContain('Alice');
            // Receipt names the new owner and carries the compromise hint.
            expect(String(receipt.subject).toLowerCase()).toContain(
                'transferred'
            );
            expect(String(receipt.text)).toContain('Bob');
            expect(String(receipt.text).toLowerCase()).toContain(
                'compromised'
            );
        } finally {
            restore();
        }
    });
});
