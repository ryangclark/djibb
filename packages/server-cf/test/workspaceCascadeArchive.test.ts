// ADR 0011 §Step 10a.4b / ADR 0008: tests for the workspace cascade-
// archive sweep. The trigger sits in `_handlePush` (archiving a
// workspace entity enqueues the `cascade-archive` alarm event); the
// handler `handleCascadeArchive` reads child entities from D1 and
// dispatches `cascadeArchiveList` to each child DO via synthetic-
// client RPC. We test those two surfaces separately:
//
//   1. Trigger — archiving a workspace lands a `cascade-archive` event
//      in DO storage. Archiving a list does NOT.
//   2. Handler — given 0/1/N children rows in the catalog with
//      varying cascade_source / time_deleted state, the handler
//      cascades the right ones and re-arms when more remain.
//
// We invoke `handleCascadeArchive` directly (it's non-private for the
// same reason `handleReconcile` is — see comment on `runAlarmEvent`)
// rather than going through the dispatcher, because dispatcher-routing
// is its own concern covered in reconcileAlarm.test.ts.

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
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

async function mintWorkspace(
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
            body: { workspaceId: wsId, name: `WS-${suffix}` },
        }),
    });
    return { wsId, stub };
}

async function mintListUnderWorkspace(
    suffix: string,
    wsId: string,
    ownerId: string
): Promise<{ id: string; stub: DurableObjectStub<DjibbList> }> {
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
            body: { listId: id, workspaceId: wsId },
        }),
    });
    return { id, stub };
}

async function archiveWorkspace(
    wsId: string,
    stub: DurableObjectStub<DjibbList>,
    ownerId: string,
    suffix: string,
    mutationId: number
): Promise<void> {
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'owner',
        listId: wsId,
        pushRequest: makePush({
            clientGroupID: `cg_${suffix}`,
            clientID: `c_${suffix}`,
            name: 'archiveList',
            mutationId,
            accountId: ownerId,
            body: { listId: wsId },
        }),
    });
}

describe('workspace cascade-archive trigger', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    // Note: a direct "alarm:cascade-archive:at exists after archive"
    // assertion would be racy under suite load — the Cloudflare DO
    // test runtime fires overdue alarms asynchronously, so by the
    // time we read storage the dispatcher may have already run and
    // canceled the event (handleCascadeArchive cancels on an empty
    // batch). Trigger semantics are covered by the end-to-end test
    // below: we drive `alarm()` directly (rather than
    // `handleCascadeArchive()`) so the dispatcher routes through the
    // event queue. If the trigger failed to schedule cascade-archive,
    // the dispatcher's legacy-fire branch runs reconcile instead and
    // the child's catalog row stays untouched — which the assertion
    // would catch.

    it('end-to-end: archive triggers dispatcher routing to cascade-archive', async () => {
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('e2ea', owner);
        const { id: childId } = await mintListUnderWorkspace(
            'e2eaL',
            wsId,
            owner
        );

        await archiveWorkspace(wsId, wsStub, owner, 'e2ea', 2);

        // Drive the dispatcher directly. If the trigger fired,
        // `readPendingAlarmEvents` returns cascade-archive and
        // `runAlarmEvent` invokes `handleCascadeArchive`. If the
        // trigger silently failed, the queue would be empty and the
        // dispatcher's legacy-fire branch runs reconcile instead —
        // which doesn't touch the child's catalog row.
        await runInDurableObject(wsStub, async i => i.alarm());

        const after = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();

        expect(after!.cascade_source).toBe(wsId);
        expect(after!.time_deleted).not.toBeNull();
    });

    it('archiving a list does NOT enqueue cascade-archive', async () => {
        // The list's own DO archives — its alarm storage should carry
        // only the reconcile event, not cascade-archive. Important
        // because the trigger guard is the id-prefix check; if it
        // ever weakens, every archived list would fan out.
        const owner = newId('account');
        const { wsId } = await mintWorkspace('trg2ws', owner);
        const { id: childId, stub: childStub } =
            await mintListUnderWorkspace('trg2ls', wsId, owner);

        await childStub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId: childId,
            pushRequest: makePush({
                clientGroupID: `cg_l_trg2ls`,
                clientID: `c_l_trg2ls`,
                name: 'archiveList',
                mutationId: 2,
                accountId: owner,
                body: { listId: childId },
            }),
        });

        const dueAt = await runInDurableObject(
            childStub,
            async (_i, state) =>
                state.storage.get<number>('alarm:cascade-archive:at')
        );
        expect(dueAt).toBeUndefined();
    });
});

describe('workspace cascade-archive handler', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('with no children, drains and cancels the event', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintWorkspace('h0', owner);
        await archiveWorkspace(wsId, stub, owner, 'h0', 2);

        await runInDurableObject(stub, async i =>
            i.handleCascadeArchive()
        );

        const dueAt = await runInDurableObject(stub, async (_i, state) =>
            state.storage.get<number>('alarm:cascade-archive:at')
        );
        expect(dueAt).toBeUndefined();
    });

    it('cascades a single child list into cascade_source', async () => {
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('h1w', owner);
        const { id: childId } = await mintListUnderWorkspace(
            'h1l',
            wsId,
            owner
        );

        await archiveWorkspace(wsId, wsStub, owner, 'h1w', 2);

        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );

        const projected = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();

        expect(projected).not.toBeNull();
        expect(projected!.cascade_source).toBe(wsId);
        expect(projected!.time_deleted).not.toBeNull();
    });

    it('skips an already-user-archived child (cascade_source stays null)', async () => {
        // Setup: child is archived manually BEFORE the workspace
        // gets deleted. The SELECT filter
        // `time_deleted IS NULL AND cascade_source IS NULL` excludes
        // it. After the workspace cascade fires, the child's
        // cascade_source must remain null — proving the user's prior
        // intent is preserved for the eventual restore (10a.5).
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('h2w', owner);
        const { id: childId, stub: childStub } =
            await mintListUnderWorkspace('h2l', wsId, owner);

        // User archives the child first.
        await childStub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId: childId,
            pushRequest: makePush({
                clientGroupID: `cg_l_h2l`,
                clientID: `c_l_h2l`,
                name: 'archiveList',
                mutationId: 2,
                accountId: owner,
                body: { listId: childId },
            }),
        });

        // Workspace gets archived; cascade sweep runs.
        await archiveWorkspace(wsId, wsStub, owner, 'h2w', 2);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );

        const projected = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null }>();

        expect(projected!.cascade_source).toBeNull();
    });

    it('mid-sweep restore: workspace not deleted, handler aborts', async () => {
        // Simulate: cascade-archive event was scheduled but the user
        // restored the workspace before the alarm fired. The handler
        // checks the workspace's own time_deleted; null → cancel the
        // event without touching any children.
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('h3w', owner);
        const { id: childId } = await mintListUnderWorkspace(
            'h3l',
            wsId,
            owner
        );

        // No workspace archive — handler invoked while workspace is
        // still live. Manually enqueue the event to simulate a stale
        // schedule.
        await runInDurableObject(wsStub, async (_i, state) => {
            await state.storage.put(
                'alarm:cascade-archive:at',
                Date.now()
            );
        });

        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );

        const dueAt = await runInDurableObject(
            wsStub,
            async (_i, state) =>
                state.storage.get<number>('alarm:cascade-archive:at')
        );
        expect(dueAt).toBeUndefined();

        // And the child wasn't touched.
        const projected = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();
        expect(projected!.cascade_source).toBeNull();
        expect(projected!.time_deleted).toBeNull();
    });

    it('re-arms cascade-archive after a non-empty batch (continues draining)', async () => {
        // Even a 1-child batch re-arms the alarm — the SELECT could
        // race with a concurrent write, so the handler doesn't trust
        // "less than N rows = drained." Only an empty result cancels
        // the event. The next tick's SELECT will return empty and
        // cancel naturally.
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('h4w', owner);
        await mintListUnderWorkspace('h4l', wsId, owner);

        await archiveWorkspace(wsId, wsStub, owner, 'h4w', 2);

        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );

        const dueAt = await runInDurableObject(
            wsStub,
            async (_i, state) =>
                state.storage.get<number>('alarm:cascade-archive:at')
        );
        expect(dueAt).toBeDefined();
    });
});
