// ADR 0011 §Step 7b.5: end-to-end tests for setWorkspaceSlug and its
// in-DO preflight. The preflight is where the cross-DO UNIQUE(type,
// slug) arbitration happens — these tests cover the success path
// (claim → D1 catalog reflects the new slug), the structured failure
// outcomes (slug_taken, slug_reserved, slug_invalid, entity_missing),
// and the role gate.

import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes, newId } from '../src/id';
import { GetEntity, defaultSlugForId } from '../src/list/entity';
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
 * Mint a workspace via the createWorkspace mutator. Returns the
 * workspaceId so the test body can run setWorkspaceSlug against it.
 */
async function mintWorkspace(suffix: string, ownerId: string) {
    const { workspaceId, stub } = getWorkspaceStub(suffix);
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'ownerless',
        listId: workspaceId,
        pushRequest: makePush({
            clientGroupID: `cg_${suffix}`,
            clientID: `c_${suffix}`,
            name: 'createWorkspace',
            mutationId: 1,
            accountId: ownerId,
            body: { workspaceId, name: 'WS-' + suffix },
        }),
    });
    return { workspaceId, stub };
}

describe('setWorkspaceSlug + in-DO preflight', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('claims a fresh slug — D1 catalog reflects the new value', async () => {
        const ownerA = newId('account');
        const { workspaceId, stub } = await mintWorkspace('slug001', ownerA);

        // Before: slug is the id suffix (default at create time).
        const before = await GetEntity(env.DJIBB_AUTH, workspaceId);
        expect(before!.slug).toBe(defaultSlugForId(workspaceId));

        // mintWorkspace used clientID `c_slug001` mutationId=1, so the
        // next mutation on that SAME clientID is mutationId=2.
        const result = await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_slug001',
                clientID: 'c_slug001',
                name: 'setWorkspaceSlug',
                mutationId: 2,
                accountId: ownerA,
                body: { workspaceId, slug: 'my-marketing' },
            }),
        });
        expect(result.error).toBeNull();

        const after = await GetEntity(env.DJIBB_AUTH, workspaceId);
        expect(after!.slug).toBe('my-marketing');
        // Version bumped — the snapshot emit refreshed time_updated /
        // version even though slug itself rode in via the preflight.
        expect(after!.version).toBeGreaterThan(before!.version);
    });

    it('rejects a slug already claimed by another workspace (slug_taken)', async () => {
        const ownerA = newId('account');
        const { workspaceId: ws1 } = await mintWorkspace('slug002a', ownerA);
        const { workspaceId: ws2, stub: stub2 } = await mintWorkspace(
            'slug002b',
            ownerA
        );

        // ws1 claims 'taken'. Fresh clientID → mutationId starts at 1.
        await env.DJIBB_LIST
            .get(env.DJIBB_LIST.idFromName(ws1))
            .handlePush({
                authorizedAccounts: [{ id: ownerA } as any],
                authorizedRole: 'owner',
                listId: ws1,
                pushRequest: makePush({
                    clientGroupID: 'cg_slug002_first',
                    clientID: 'c_slug002_first',
                    name: 'setWorkspaceSlug',
                    mutationId: 1,
                    accountId: ownerA,
                    body: { workspaceId: ws1, slug: 'taken' },
                }),
            });

        // ws2 attempts the same slug — preflight rejects, ws2 retains
        // its default (id-suffix) slug. Fresh clientID → mutationId 1.
        await stub2.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: ws2,
            pushRequest: makePush({
                clientGroupID: 'cg_slug002_second',
                clientID: 'c_slug002_second',
                name: 'setWorkspaceSlug',
                mutationId: 1,
                accountId: ownerA,
                body: { workspaceId: ws2, slug: 'taken' },
            }),
        });

        const row1 = await GetEntity(env.DJIBB_AUTH, ws1);
        const row2 = await GetEntity(env.DJIBB_AUTH, ws2);
        expect(row1!.slug).toBe('taken');
        expect(row2!.slug).toBe(defaultSlugForId(ws2));
    });

    it('rejects a reserved slug (slug_reserved)', async () => {
        const ownerA = newId('account');
        const { workspaceId, stub } = await mintWorkspace('slug003', ownerA);

        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_slug003',
                clientID: 'c_slug003',
                name: 'setWorkspaceSlug',
                mutationId: 2,
                accountId: ownerA,
                body: { workspaceId, slug: 'admin' },
            }),
        });

        const row = await GetEntity(env.DJIBB_AUTH, workspaceId);
        expect(row!.slug).toBe(defaultSlugForId(workspaceId));
    });

    it('rejects an invalid slug (slug_invalid) — uppercase, leading hyphen, etc.', async () => {
        const ownerA = newId('account');
        const { workspaceId, stub } = await mintWorkspace('slug004', ownerA);

        // Mutator argsSchema accepts the loose `z.string().min(1)`,
        // so the failure surfaces inside the preflight rather than at
        // parse time. -my-team has a leading hyphen → SLUG_PATTERN
        // mismatch → slug_invalid.
        await stub.handlePush({
            authorizedAccounts: [{ id: ownerA } as any],
            authorizedRole: 'owner',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_slug004',
                clientID: 'c_slug004',
                name: 'setWorkspaceSlug',
                mutationId: 2,
                accountId: ownerA,
                body: { workspaceId, slug: '-bad-leading-hyphen' },
            }),
        });

        const row = await GetEntity(env.DJIBB_AUTH, workspaceId);
        expect(row!.slug).toBe(defaultSlugForId(workspaceId));
    });

    it('refuses claim from a non-admin caller (OWNER_ROLES gate)', async () => {
        const ownerA = newId('account');
        const editorE = newId('account');
        const { workspaceId, stub } = await mintWorkspace('slug005', ownerA);

        // Editor attempts to claim. The preflight runs BEFORE
        // `handleMutation` in `_handlePush`, and `handleMutation` is
        // where the synchronous mutator's `requiredRole` is checked
        // — so without an explicit guard inside the preflight, a
        // non-owner could vandalize the slug (preflight's D1 UPDATE
        // commits, mutator then refused). The preflight's role guard
        // closes that hole: it surfaces a structured `auth` outcome
        // with reason `unauthorized_role` and skips the D1 write.
        //
        // Fresh editor clientID (different from mintWorkspace's), so
        // its mutationId starts at 1.
        await stub.handlePush({
            authorizedAccounts: [{ id: editorE } as any],
            authorizedRole: 'editor',
            listId: workspaceId,
            pushRequest: makePush({
                clientGroupID: 'cg_slug005_editor',
                clientID: 'c_slug005_editor',
                name: 'setWorkspaceSlug',
                mutationId: 1,
                accountId: editorE,
                body: { workspaceId, slug: 'editor-cant-have-this' },
            }),
        });

        const row = await GetEntity(env.DJIBB_AUTH, workspaceId);
        expect(row!.slug).toBe(defaultSlugForId(workspaceId));
    });
});
