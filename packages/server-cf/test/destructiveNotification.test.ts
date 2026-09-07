// ADR 0023 §2 / issue #18: unit tests for the destructive-action
// notification — the owner-only heads-up email fired post-commit when a
// push arms the 30-day hard-delete clock (archive / startFresh not undone
// in the same push). Mirrors notifications.unit.test.ts's harness: a real
// miniflare `sql` (from a minted entity DO) + a capturing `env.EMAIL`
// spy, driving the free functions directly so the owner-resolution,
// arm/clear gating, and copy are assertable without a full HTTP push.

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';
import type { Account } from '@djibb/protocol/account';

import {
    applyDestructiveNotification,
    fireDestructiveActionEmail,
} from '../src/list/notifications';
import { DjibbList } from '../src/list/durable_object';
import {
    emptyPostCommitIntent,
    foldCommittedMutation,
} from '../src/list/postCommit';
import { formatRecoverableUntil } from '../src/email';
import { CreateAccount } from '../src/account/service';
import { ID_LENGTH, IdTypes, newId } from '@djibb/protocol/id';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

const HARD_DELETE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * Mint a list entity owned by `ownerId` (an authed creator becomes
 * `owner` in the entity's auth rules — initList §rulesFor). Pass
 * `ownerId: null` to mint an ownerless list.
 */
async function mintListEntity(
    suffix: string,
    ownerId: string | null
): Promise<{ id: string; stub: DurableObjectStub<DjibbList> }> {
    const wsId = workspaceId(`${suffix}w`);
    const wsStub = getStub(wsId);
    await wsStub.handlePush({
        authorizedAccounts: ownerId ? [{ id: ownerId } as any] : [],
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
        authorizedAccounts: ownerId ? [{ id: ownerId } as any] : [],
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
 *  array and a restore fn. Mirrors notifications.unit.test.ts. */
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

describe('fireDestructiveActionEmail (free function)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('emails the owner once with the 30-day deadline and the /trash restore link', async () => {
        const owner = await CreateAccount(env as any, makeAccount());
        const { id, stub } = await mintListEntity('dn1', owner.id);
        const recoverableUntil = Date.now() + HARD_DELETE_DELAY_MS;
        const { sends, restore } = spyOnEmail();
        try {
            await runInDurableObject(stub, async (i) =>
                fireDestructiveActionEmail(
                    i.sql,
                    env as any,
                    id,
                    recoverableUntil
                )
            );

            expect(sends).toHaveLength(1);
            const sent = sends[0]!;
            expect(sent.to).toBe(owner.email);
            // Restore surface is the single /trash page, not the entity URL.
            expect(String(sent.text)).toContain('/trash');
            // The hard-purge deadline is spelled out in the copy.
            const deadline = formatRecoverableUntil(recoverableUntil);
            expect(String(sent.text)).toContain(deadline);
            expect(String(sent.html)).toContain(deadline);
        } finally {
            restore();
        }
    });

    it('ownerless entity: no owner to notify, so no email', async () => {
        const { id, stub } = await mintListEntity('dn2', null);
        const { sends, restore } = spyOnEmail();
        try {
            await runInDurableObject(stub, async (i) =>
                fireDestructiveActionEmail(
                    i.sql,
                    env as any,
                    id,
                    Date.now() + HARD_DELETE_DELAY_MS
                )
            );
            expect(sends).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('owner has no email on file: skips without sending or throwing', async () => {
        // Owner id present in the rules but no D1 accounts row → no email.
        const { id, stub } = await mintListEntity('dn3', newId('account'));
        const { sends, restore } = spyOnEmail();
        try {
            await expect(
                runInDurableObject(stub, async (i) =>
                    fireDestructiveActionEmail(
                        i.sql,
                        env as any,
                        id,
                        Date.now() + HARD_DELETE_DELAY_MS
                    )
                )
            ).resolves.toBeUndefined();
            expect(sends).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('no EMAIL binding: resolves without sending or throwing', async () => {
        const owner = await CreateAccount(env as any, makeAccount());
        const { id, stub } = await mintListEntity('dn4', owner.id);
        const original = (env as { EMAIL?: unknown }).EMAIL;
        (env as { EMAIL?: unknown }).EMAIL = undefined;
        try {
            await expect(
                runInDurableObject(stub, async (i) =>
                    fireDestructiveActionEmail(
                        i.sql,
                        env as any,
                        id,
                        Date.now() + HARD_DELETE_DELAY_MS
                    )
                )
            ).resolves.toBeUndefined();
        } finally {
            (env as { EMAIL?: unknown }).EMAIL = original;
        }
    });
});

describe('applyDestructiveNotification (tail) + arm/clear gating', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('archive push (net arm): owner emailed once', async () => {
        const owner = await CreateAccount(env as any, makeAccount());
        const { id, stub } = await mintListEntity('ap1', owner.id);
        // The DO derives `armed` from the pure fold; reproduce that here.
        const intent = foldCommittedMutation(
            emptyPostCommitIntent(),
            { name: 'archiveList', args: {} },
            id
        );
        expect(intent.harddelete).toBe('arm');
        const { sends, restore } = spyOnEmail();
        try {
            await runInDurableObject(stub, async (i) =>
                applyDestructiveNotification(
                    { sql: i.sql, env: env as any },
                    {
                        entityId: id,
                        armed: intent.harddelete === 'arm',
                        recoverableUntil: Date.now() + HARD_DELETE_DELAY_MS,
                    }
                )
            );
            expect(sends).toHaveLength(1);
            expect(sends[0]!.to).toBe(owner.email);
        } finally {
            restore();
        }
    });

    it('non-destructive push (net null): no email', async () => {
        const owner = await CreateAccount(env as any, makeAccount());
        const { id, stub } = await mintListEntity('ap2', owner.id);
        const intent = foldCommittedMutation(
            emptyPostCommitIntent(),
            { name: 'renameList', args: {} },
            id
        );
        expect(intent.harddelete).toBeNull();
        const { sends, restore } = spyOnEmail();
        try {
            await runInDurableObject(stub, async (i) =>
                applyDestructiveNotification(
                    { sql: i.sql, env: env as any },
                    {
                        entityId: id,
                        armed: intent.harddelete === 'arm',
                        recoverableUntil: Date.now() + HARD_DELETE_DELAY_MS,
                    }
                )
            );
            expect(sends).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('archive-then-unarchive in one push (net clear): no email', async () => {
        const owner = await CreateAccount(env as any, makeAccount());
        const { id, stub } = await mintListEntity('ap3', owner.id);
        // Last write wins: arm then clear nets `clear`, so no arm fires.
        let intent = foldCommittedMutation(
            emptyPostCommitIntent(),
            { name: 'archiveList', args: {} },
            id
        );
        intent = foldCommittedMutation(
            intent,
            { name: 'unarchiveList', args: {} },
            id
        );
        expect(intent.harddelete).toBe('clear');
        const { sends, restore } = spyOnEmail();
        try {
            await runInDurableObject(stub, async (i) =>
                applyDestructiveNotification(
                    { sql: i.sql, env: env as any },
                    {
                        entityId: id,
                        armed: intent.harddelete === 'arm',
                        recoverableUntil: Date.now() + HARD_DELETE_DELAY_MS,
                    }
                )
            );
            expect(sends).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('client-agnostic: the tail takes no session/credential input, so a token- and a session-authed arm produce the same email', async () => {
        // The acceptance criterion for non-interactive clients (#18):
        // because the arm signal is captured post-commit, the notification
        // depends only on (entityId, armed, deadline) — there is no auth
        // input to vary. Firing "twice" (standing in for a token push and
        // a session push) yields identical recipients/copy by construction.
        const owner = await CreateAccount(env as any, makeAccount());
        const { id, stub } = await mintListEntity('ap4', owner.id);
        const recoverableUntil = Date.now() + HARD_DELETE_DELAY_MS;
        const { sends, restore } = spyOnEmail();
        try {
            for (const _authFlavor of ['token', 'session']) {
                await runInDurableObject(stub, async (i) =>
                    applyDestructiveNotification(
                        { sql: i.sql, env: env as any },
                        { entityId: id, armed: true, recoverableUntil }
                    )
                );
            }
            expect(sends).toHaveLength(2);
            expect(sends[0]!.to).toBe(sends[1]!.to);
            expect(sends[0]!.subject).toBe(sends[1]!.subject);
        } finally {
            restore();
        }
    });
});
