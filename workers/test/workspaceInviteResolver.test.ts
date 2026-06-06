// ADR 0011 §Step 10d.3a: tests for ResolveInvitedWorkspaceBySlug, the
// gated slug→id lookup behind the pre-membership workspace-invite accept
// surface. The gate is the whole point: a match returns the entity id
// only when the caller's identity holds a pending, unexpired invite to
// the workspace with that slug. Every negative case must be
// indistinguishable (null → 404 at the route).

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import { ResolveInvitedWorkspaceBySlug } from '../src/workspace/service';
import { ensureD1Schema, resetWorkspaceData } from './helpers/d1';

function getWorkspaceStub(suffix: string) {
    const prefixed = `${IdTypes.workspace}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        workspaceId: prefixed,
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

/**
 * Mint a workspace, claim `slug`, and invite `inviteEmail` as editor.
 * Returns the workspace id. All three mutations ride one clientID so
 * mutationIds stay sequential.
 */
async function seedInvitedWorkspace({
    suffix,
    slug,
    ownerId,
    inviteEmail,
}: {
    suffix: string;
    slug: string;
    ownerId: string;
    inviteEmail: string;
}): Promise<string> {
    const { workspaceId, stub } = getWorkspaceStub(suffix);
    const cg = `cg_${suffix}`;
    const cid = `c_${suffix}`;

    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'ownerless',
        listId: workspaceId,
        pushRequest: makePush({
            clientGroupID: cg,
            clientID: cid,
            name: 'createWorkspace',
            mutationId: 1,
            accountId: ownerId,
            body: { workspaceId, name: 'Invite Team' },
        }),
    });
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'owner',
        listId: workspaceId,
        pushRequest: makePush({
            clientGroupID: cg,
            clientID: cid,
            name: 'setWorkspaceSlug',
            mutationId: 2,
            accountId: ownerId,
            body: { workspaceId, slug },
        }),
    });
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId, display_name: 'Owner' } as any],
        authorizedRole: 'owner',
        listId: workspaceId,
        pushRequest: makePush({
            clientGroupID: cg,
            clientID: cid,
            name: 'inviteByIdentity',
            mutationId: 3,
            accountId: ownerId,
            body: {
                listId: workspaceId,
                identity_kind: 'email',
                identity_value: inviteEmail,
                role: 'editor',
            },
        }),
    });
    return workspaceId;
}

describe('ResolveInvitedWorkspaceBySlug', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    const now = () => Math.floor(Date.now() / 1000);

    it('resolves id + name when the identity holds a pending invite', async () => {
        const ownerId = newId('account');
        const workspaceId = await seedInvitedWorkspace({
            suffix: 'res001',
            slug: 'res-team',
            ownerId,
            inviteEmail: 'invitee@example.com',
        });

        const resolved = await ResolveInvitedWorkspaceBySlug(env.DJIBB_AUTH, {
            slug: 'res-team',
            identityValues: ['invitee@example.com'],
            nowSeconds: now(),
        });

        expect(resolved).not.toBeNull();
        expect(resolved!.id).toBe(workspaceId);
        expect(resolved!.name).toBe('Invite Team');
    });

    it('normalizes nothing — caller passes lowercased emails, match is exact', async () => {
        const ownerId = newId('account');
        await seedInvitedWorkspace({
            suffix: 'res002',
            slug: 'res-team2',
            ownerId,
            // inviteByIdentity lowercases the stored identity, so this
            // lands as 'mixed@example.com' in the index.
            inviteEmail: 'Mixed@Example.com',
        });

        const resolved = await ResolveInvitedWorkspaceBySlug(env.DJIBB_AUTH, {
            slug: 'res-team2',
            identityValues: ['mixed@example.com'],
            nowSeconds: now(),
        });
        expect(resolved).not.toBeNull();
    });

    it('returns null when no identity matches a pending invite', async () => {
        const ownerId = newId('account');
        await seedInvitedWorkspace({
            suffix: 'res003',
            slug: 'res-team3',
            ownerId,
            inviteEmail: 'invitee@example.com',
        });

        const resolved = await ResolveInvitedWorkspaceBySlug(env.DJIBB_AUTH, {
            slug: 'res-team3',
            identityValues: ['stranger@example.com'],
            nowSeconds: now(),
        });
        expect(resolved).toBeNull();
    });

    it('returns null for an empty identity set', async () => {
        const ownerId = newId('account');
        await seedInvitedWorkspace({
            suffix: 'res004',
            slug: 'res-team4',
            ownerId,
            inviteEmail: 'invitee@example.com',
        });

        const resolved = await ResolveInvitedWorkspaceBySlug(env.DJIBB_AUTH, {
            slug: 'res-team4',
            identityValues: [],
            nowSeconds: now(),
        });
        expect(resolved).toBeNull();
    });

    it('returns null for an unknown slug even with a valid identity', async () => {
        const ownerId = newId('account');
        await seedInvitedWorkspace({
            suffix: 'res005',
            slug: 'res-team5',
            ownerId,
            inviteEmail: 'invitee@example.com',
        });

        const resolved = await ResolveInvitedWorkspaceBySlug(env.DJIBB_AUTH, {
            slug: 'no-such-slug',
            identityValues: ['invitee@example.com'],
            nowSeconds: now(),
        });
        expect(resolved).toBeNull();
    });

    it('returns null once the invite has expired', async () => {
        const ownerId = newId('account');
        await seedInvitedWorkspace({
            suffix: 'res006',
            slug: 'res-team6',
            ownerId,
            inviteEmail: 'invitee@example.com',
        });

        // Evaluate the gate at a time past the invite's TTL.
        const farFuture = now() + 100 * 365 * 24 * 60 * 60;
        const resolved = await ResolveInvitedWorkspaceBySlug(env.DJIBB_AUTH, {
            slug: 'res-team6',
            identityValues: ['invitee@example.com'],
            nowSeconds: farFuture,
        });
        expect(resolved).toBeNull();
    });
});
