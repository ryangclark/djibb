// ADR 0008 / ADR 0011 §Step 10c: tests for the personal-workspace
// "Start Fresh" verb. Four concerns:
//
//   1. `startFresh` archives the current personal workspace + mints a
//      fresh new one (the post-commit tail invokes
//      `mintPersonalWorkspaceEntity`).
//   2. `startFresh` rejects non-personal workspaces (and non-workspace
//      entities).
//   3. `archiveList` rejects personal workspaces (guard against
//      bypassing `startFresh`).
//   4. `unarchiveList` on a personal workspace demotes its slot to
//      NULL (the invariant: at most one current personal workspace
//      per account; the just-minted replacement already holds the
//      slot, so the restored one becomes a regular team workspace).

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { ID_LENGTH, IdTypes, newId } from '../src/id';
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

async function mintPersonalWorkspace(
    suffix: string,
    ownerId: string
): Promise<{ wsId: string; stub: DurableObjectStub<DjibbList> }> {
    const wsId = workspaceId(suffix);
    const stub = getStub(wsId);
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'ownerless',
        listId: wsId,
        pushRequest: makePush({
            clientGroupID: `cg_${suffix}`,
            clientID: `c_${suffix}`,
            name: 'createWorkspace',
            mutationId: 1,
            accountId: ownerId,
            body: {
                workspaceId: wsId,
                name: 'Personal',
                slot: 'personal_workspace',
            },
        }),
    });
    return { wsId, stub };
}

async function mintTeamWorkspace(
    suffix: string,
    ownerId: string
): Promise<{ wsId: string; stub: DurableObjectStub<DjibbList> }> {
    const wsId = workspaceId(suffix);
    const stub = getStub(wsId);
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'ownerless',
        listId: wsId,
        pushRequest: makePush({
            clientGroupID: `cg_${suffix}`,
            clientID: `c_${suffix}`,
            name: 'createWorkspace',
            mutationId: 1,
            accountId: ownerId,
            body: { workspaceId: wsId, name: 'Team WS' },
        }),
    });
    return { wsId, stub };
}

async function startFresh(
    wsId: string,
    stub: DurableObjectStub<DjibbList>,
    ownerId: string,
    suffix: string,
    mutationId: number,
    displayName: string | null = null
): Promise<void> {
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'owner',
        listId: wsId,
        pushRequest: makePush({
            clientGroupID: `cg_${suffix}`,
            clientID: `c_${suffix}`,
            name: 'startFresh',
            mutationId,
            accountId: ownerId,
            body: { workspaceId: wsId, accountDisplayName: displayName },
        }),
    });
}

describe('startFresh', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('archives the personal workspace and mints a fresh one', async () => {
        const owner = newId('account');
        const { wsId: oldId, stub } = await mintPersonalWorkspace('sf1', owner);

        await startFresh(oldId, stub, owner, 'sf1', 2, 'Alice');

        // Old workspace is soft-deleted in the catalog.
        const oldRow = await env.DJIBB_AUTH.prepare(
            `SELECT time_deleted, slot FROM workspace_entities WHERE id = ?`
        )
            .bind(oldId)
            .first<{ time_deleted: number | null; slot: string | null }>();
        expect(oldRow).not.toBeNull();
        expect(oldRow!.time_deleted).not.toBeNull();
        // The old workspace keeps its `slot='personal_workspace'` value
        // until restore; only restore demotes (so Trash queries can
        // tell which Trash entries came from a Start Fresh flow if
        // they ever want to).
        expect(oldRow!.slot).toBe('personal_workspace');

        // A fresh personal workspace was minted for the same actor.
        const fresh = await env.DJIBB_AUTH.prepare(
            `SELECT we.id, we.name, we.slot, we.time_deleted
             FROM workspace_entities we
             JOIN entity_memberships em ON em.entity_id = we.id
             WHERE em.account_id = ?
               AND em.role = 'owner'
               AND we.slot = 'personal_workspace'
               AND we.time_deleted IS NULL
               AND we.id != ?`
        )
            .bind(owner, oldId)
            .first<{ id: string; name: string; slot: string }>();
        expect(fresh).not.toBeNull();
        expect(fresh!.slot).toBe('personal_workspace');
        expect(fresh!.name).toContain('Alice');
    });

    it('arms the harddelete clock on the archived workspace', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintPersonalWorkspace('sfh', owner);
        await startFresh(wsId, stub, owner, 'sfh', 2);

        const dueAt = await runInDurableObject(stub, async (_i, state) =>
            state.storage.get<number>('alarm:harddelete:at')
        );
        expect(dueAt).toBeDefined();
    });

    it('end-to-end: cascade-archives a child after alarm() runs', async () => {
        // The cascade-archive trigger fires for `startFresh` identically
        // to `archiveList` (same `cascadeArchiveTriggered` flag).
        // Bare storage-state assertion would be racy (the cascade
        // event is scheduled at `Date.now()`, and the test runtime
        // may fire it between the push and the read); use the same
        // deterministic pattern as workspaceCascadeArchive.test.ts —
        // seed a child, drive `alarm()`, assert the child's catalog
        // row picked up `cascade_source = workspace`.
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintPersonalWorkspace(
            'sfc',
            owner
        );
        // Seed a child list under the personal workspace.
        const childId = listId('sfcL');
        const childStub = getStub(childId);
        await childStub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'ownerless',
            listId: childId,
            pushRequest: makePush({
                clientGroupID: 'cg_l_sfcL',
                clientID: 'c_l_sfcL',
                name: 'initList',
                mutationId: 1,
                accountId: owner,
                body: { listId: childId, workspaceId: wsId },
            }),
        });

        await startFresh(wsId, wsStub, owner, 'sfc', 2);

        // Drive the dispatcher → handleCascadeArchive → cascade child.
        await runInDurableObject(wsStub, async i => i.alarm());

        const childRow = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{
                cascade_source: string | null;
                time_deleted: number | null;
            }>();
        expect(childRow!.cascade_source).toBe(wsId);
        expect(childRow!.time_deleted).not.toBeNull();
    });

    it('rejects a team (non-personal) workspace', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintTeamWorkspace('sfx', owner);
        // The DO swallows mutator throws and skip-acks; the
        // observable signal is "workspace did not get soft-deleted".
        await startFresh(wsId, stub, owner, 'sfx', 2);

        const row = await env.DJIBB_AUTH.prepare(
            `SELECT time_deleted, slot FROM workspace_entities WHERE id = ?`
        )
            .bind(wsId)
            .first<{ time_deleted: number | null; slot: string | null }>();
        expect(row!.time_deleted).toBeNull();
        expect(row!.slot).toBeNull();
    });
});

describe('archiveList guards personal workspaces', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('rejects archiveList on a personal workspace', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintPersonalWorkspace('alg', owner);

        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId: wsId,
            pushRequest: makePush({
                clientGroupID: 'cg_alg',
                clientID: 'c_alg',
                name: 'archiveList',
                mutationId: 2,
                accountId: owner,
                body: { listId: wsId },
            }),
        });

        const row = await env.DJIBB_AUTH.prepare(
            `SELECT time_deleted FROM workspace_entities WHERE id = ?`
        )
            .bind(wsId)
            .first<{ time_deleted: number | null }>();
        expect(row!.time_deleted).toBeNull();
    });

    it('still archives a team workspace via archiveList', async () => {
        // Regression: the personal-workspace guard must not affect the
        // ordinary team-workspace delete flow built in 10a.
        const owner = newId('account');
        const { wsId, stub } = await mintTeamWorkspace('alg2', owner);

        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId: wsId,
            pushRequest: makePush({
                clientGroupID: 'cg_alg2',
                clientID: 'c_alg2',
                name: 'archiveList',
                mutationId: 2,
                accountId: owner,
                body: { listId: wsId },
            }),
        });

        const row = await env.DJIBB_AUTH.prepare(
            `SELECT time_deleted FROM workspace_entities WHERE id = ?`
        )
            .bind(wsId)
            .first<{ time_deleted: number | null }>();
        expect(row!.time_deleted).not.toBeNull();
    });
});

describe('unarchiveList demotes personal workspace slot', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('clears slot on restore of a personal workspace', async () => {
        // End-to-end: Start Fresh archives W_old + mints W_new, then
        // the user restores W_old from Trash. W_old comes back as a
        // regular workspace (slot=NULL); W_new keeps the personal
        // slot.
        const owner = newId('account');
        const { wsId: oldId, stub: oldStub } = await mintPersonalWorkspace(
            'd1',
            owner
        );
        await startFresh(oldId, oldStub, owner, 'd1', 2);

        // Restore the old workspace.
        await oldStub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId: oldId,
            pushRequest: makePush({
                clientGroupID: 'cg_d1',
                clientID: 'c_d1',
                name: 'unarchiveList',
                mutationId: 3,
                accountId: owner,
                body: { listId: oldId },
            }),
        });

        const restored = await env.DJIBB_AUTH.prepare(
            `SELECT time_deleted, slot FROM workspace_entities WHERE id = ?`
        )
            .bind(oldId)
            .first<{ time_deleted: number | null; slot: string | null }>();
        expect(restored!.time_deleted).toBeNull();
        expect(restored!.slot).toBeNull();

        // The freshly-minted replacement still holds the personal slot.
        const personalCount = await env.DJIBB_AUTH.prepare(
            `SELECT COUNT(*) AS n
             FROM workspace_entities we
             JOIN entity_memberships em ON em.entity_id = we.id
             WHERE em.account_id = ?
               AND em.role = 'owner'
               AND we.slot = 'personal_workspace'
               AND we.time_deleted IS NULL`
        )
            .bind(owner)
            .first<{ n: number }>();
        expect(personalCount!.n).toBe(1);
    });

    it('does NOT clear slot on a team workspace restore (regression)', async () => {
        // Sanity: ordinary team workspace restore leaves the (null)
        // slot alone; the demotion path only fires for personal.
        const owner = newId('account');
        const { wsId, stub } = await mintTeamWorkspace('d2', owner);

        // archive then restore.
        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId: wsId,
            pushRequest: makePush({
                clientGroupID: 'cg_d2',
                clientID: 'c_d2',
                name: 'archiveList',
                mutationId: 2,
                accountId: owner,
                body: { listId: wsId },
            }),
        });
        await stub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId: wsId,
            pushRequest: makePush({
                clientGroupID: 'cg_d2',
                clientID: 'c_d2',
                name: 'unarchiveList',
                mutationId: 3,
                accountId: owner,
                body: { listId: wsId },
            }),
        });

        const row = await env.DJIBB_AUTH.prepare(
            `SELECT time_deleted, slot FROM workspace_entities WHERE id = ?`
        )
            .bind(wsId)
            .first<{ time_deleted: number | null; slot: string | null }>();
        expect(row!.time_deleted).toBeNull();
        expect(row!.slot).toBeNull();
    });
});
