// ADR 0026 series 2: direct unit tests for the push post-commit
// invitation/ownership notification free functions carved out of the DO
// into `list/notifications.ts`. The end-to-end paths stay covered by
// entityInvitations.test.ts / transferOwnership.test.ts (which drive the
// thin DO delegators and are the regression signal); these tests reach
// the free functions directly with a real miniflare `sql` (from a minted
// entity DO) + a capturing `env.EMAIL` spy, to assert the URL/slug
// building and the two-independent-sends behavior without a full push.

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';
import type { Account } from '@djibb/protocol/account';

import { DjibbList } from '../src/list/durable_object';
import {
    applyInvitationPostCommit,
    fireInvitationEmails,
    fireOwnershipTransferEmails,
} from '../src/list/notifications';
import { CreateAccount } from '../src/account/service';
import { ID_LENGTH, IdTypes, newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

function getStub(prefixed: string) {
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>;
}

function workspaceId(suffix: string): string {
    return `${IdTypes.workspace}/${suffix.padEnd(ID_LENGTH, 'a').slice(0, ID_LENGTH)}`;
}

function listId(suffix: string): string {
    return `${IdTypes.list}/${suffix.padEnd(ID_LENGTH, 'a').slice(0, ID_LENGTH)}`;
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

async function mintListEntity(
    suffix: string,
    ownerId: string
): Promise<{ id: string; stub: DurableObjectStub<DjibbList> }> {
    // initList requires a workspace_id; mint a workspace first so the
    // list's entity row is well-formed.
    const wsId = workspaceId(`${suffix}w`);
    const wsStub = getStub(wsId);
    await wsStub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'ownerless',
        listId: wsId,
        pushRequest: makePush({
            clientGroupID: `cg_${suffix}w`,
            clientID: `c_${suffix}w`,
            name: 'createWorkspace',
            mutationId: 1,
            accountId: ownerId,
            body: { workspaceId: wsId, name: `WS-${suffix}` },
        }),
    });

    const id = listId(suffix);
    const stub = getStub(id);
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'ownerless',
        listId: id,
        pushRequest: makePush({
            clientGroupID: `cg_l_${suffix}`,
            clientID: `c_l_${suffix}`,
            name: 'initList',
            mutationId: 1,
            accountId: ownerId,
            body: { listId: id, workspaceId: wsId, name: `L-${suffix}` },
        }),
    });
    return { id, stub };
}

/** Swap `env.EMAIL` for a capturing spy; returns the captured sends
 *  array and a restore fn. Mirrors transferOwnership.test.ts. */
function spyOnEmail() {
    const sends: Array<Record<string, unknown>> = [];
    const original = (env as { EMAIL?: unknown }).EMAIL;
    (env as { EMAIL: unknown }).EMAIL = {
        send: async (msg: Record<string, unknown>) => {
            sends.push(msg);
        },
    };
    return {
        sends,
        restore: () => ((env as { EMAIL: unknown }).EMAIL = original),
    };
}

function sessionAccount(overrides: Partial<Account>): Account {
    return {
        id: '',
        display_name: null,
        email: null,
        email_verified: true,
        flags: null,
        image: null,
        provider_name: 'google',
        provider_client_id: 'g',
        user_name: null,
        time_created: new Date(),
        time_deleted: null,
        time_updated: new Date(),
        ...overrides,
    } as Account;
}

function makeAccount(overrides: Partial<Account> = {}): Account {
    return sessionAccount({
        display_name: 'Test User',
        email: `t-${Math.random().toString(36).slice(2)}@example.com`,
        provider_client_id: 'g-' + Math.random().toString(36).slice(2),
        ...overrides,
    });
}

describe('fireInvitationEmails (free function)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('sends one email per invitee with a from_invite accept URL and the inviter name', async () => {
        const owner = newId('account');
        const { id, stub } = await mintListEntity('inv1', owner);
        const { sends, restore } = spyOnEmail();
        try {
            await runInDurableObject(stub, async (i) =>
                fireInvitationEmails(
                    i.sql,
                    env as any,
                    id,
                    [
                        {
                            identity_kind: 'email',
                            identity_value: 'invitee@example.com',
                            inviter_account_id: owner,
                        },
                    ],
                    [sessionAccount({ id: owner, display_name: 'Ada' })]
                )
            );

            expect(sends).toHaveLength(1);
            const sent = sends[0]!;
            expect(sent.to).toBe('invitee@example.com');
            // List URL routes by id suffix and carries the accept flag.
            expect(String(sent.text)).toContain('/l/');
            expect(String(sent.text)).toContain('from_invite=1');
            // Inviter name is embedded in the body.
            expect(String(sent.html)).toContain('Ada');
        } finally {
            restore();
        }
    });

    it('no EMAIL binding: resolves without sending or throwing', async () => {
        const owner = newId('account');
        const { id, stub } = await mintListEntity('inv2', owner);
        const original = (env as { EMAIL?: unknown }).EMAIL;
        (env as { EMAIL?: unknown }).EMAIL = undefined;
        try {
            await expect(
                runInDurableObject(stub, async (i) =>
                    fireInvitationEmails(
                        i.sql,
                        env as any,
                        id,
                        [
                            {
                                identity_kind: 'email',
                                identity_value: 'invitee@example.com',
                                inviter_account_id: owner,
                            },
                        ],
                        [sessionAccount({ id: owner, display_name: 'Ada' })]
                    )
                )
            ).resolves.toBeUndefined();
        } finally {
            (env as { EMAIL?: unknown }).EMAIL = original;
        }
    });
});

describe('fireOwnershipTransferEmails (free function)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('emails both the new owner and the former owner on a resolvable transfer', async () => {
        const owner = newId('account');
        const newOwner = await CreateAccount(env as any, makeAccount());
        const { id, stub } = await mintListEntity('own1', owner);
        const { sends, restore } = spyOnEmail();
        try {
            await runInDurableObject(stub, async (i) =>
                fireOwnershipTransferEmails(
                    i.sql,
                    env as any,
                    id,
                    [
                        {
                            to_account_id: newOwner.id,
                            former_owner_account_id: owner,
                        },
                    ],
                    [
                        sessionAccount({
                            id: owner,
                            display_name: 'Alice',
                            email: 'alice@example.com',
                        }),
                    ]
                )
            );

            expect(sends).toHaveLength(2);
            const recipients = sends.map((s) => s.to).sort();
            expect(recipients).toEqual(
                [newOwner.email, 'alice@example.com'].sort()
            );
        } finally {
            restore();
        }
    });

    it('independence: unknown new owner (no D1 account) still sends the former-owner receipt', async () => {
        const owner = newId('account');
        const { id, stub } = await mintListEntity('own2', owner);
        const { sends, restore } = spyOnEmail();
        try {
            await runInDurableObject(stub, async (i) =>
                fireOwnershipTransferEmails(
                    i.sql,
                    env as any,
                    id,
                    [
                        {
                            // No accounts row exists for this id → the
                            // new-owner notify is skipped, but the former
                            // owner's receipt must still fire.
                            to_account_id: newId('account'),
                            former_owner_account_id: owner,
                        },
                    ],
                    [
                        sessionAccount({
                            id: owner,
                            display_name: 'Alice',
                            email: 'alice@example.com',
                        }),
                    ]
                )
            );

            expect(sends).toHaveLength(1);
            expect(sends[0]!.to).toBe('alice@example.com');
        } finally {
            restore();
        }
    });
});

describe('applyInvitationPostCommit (orchestrator)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('fans out both invite and ownership emails when both flags are present', async () => {
        const owner = newId('account');
        const newOwner = await CreateAccount(env as any, makeAccount());
        const { id, stub } = await mintListEntity('orch1', owner);
        const { sends, restore } = spyOnEmail();
        try {
            await runInDurableObject(stub, async (i) =>
                applyInvitationPostCommit(
                    {
                        sql: i.sql,
                        d1: env.DJIBB_AUTH,
                        env: env as any,
                        authorizedAccounts: [
                            sessionAccount({
                                id: owner,
                                display_name: 'Alice',
                                email: 'alice@example.com',
                            }),
                        ],
                    },
                    {
                        entityId: id,
                        acceptedInvites: [],
                        invitationsMutated: false,
                        sentInvites: [
                            {
                                identity_kind: 'email',
                                identity_value: 'invitee@example.com',
                                inviter_account_id: owner,
                            },
                        ],
                        transferredOwnerships: [
                            {
                                to_account_id: newOwner.id,
                                former_owner_account_id: owner,
                            },
                        ],
                    }
                )
            );

            // 1 invite email + 2 ownership emails (new-owner notify +
            // former-owner receipt).
            expect(sends).toHaveLength(3);
            const recipients = sends.map((s) => s.to).sort();
            expect(recipients).toEqual(
                ['invitee@example.com', newOwner.email, 'alice@example.com'].sort()
            );
        } finally {
            restore();
        }
    });

    it('all flags empty/false: no emails, resolves cleanly', async () => {
        const owner = newId('account');
        const { id, stub } = await mintListEntity('orch2', owner);
        const { sends, restore } = spyOnEmail();
        try {
            await expect(
                runInDurableObject(stub, async (i) =>
                    applyInvitationPostCommit(
                        {
                            sql: i.sql,
                            d1: env.DJIBB_AUTH,
                            env: env as any,
                            authorizedAccounts: [],
                        },
                        {
                            entityId: id,
                            acceptedInvites: [],
                            invitationsMutated: false,
                            sentInvites: [],
                            transferredOwnerships: [],
                        }
                    )
                )
            ).resolves.toBeUndefined();
            expect(sends).toHaveLength(0);
        } finally {
            restore();
        }
    });
});
