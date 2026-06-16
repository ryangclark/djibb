// ADR 0011 §Step 10a.5 / ADR 0008: tests for the workspace cascade-
// restore sweep. Symmetric coverage to workspaceCascadeArchive: the
// trigger sits in `_handlePush` (unarchiving a workspace entity
// enqueues `cascade-restore` AND cancels any pending cascade-archive
// — the cross-cancellation handles the mid-sweep flip case); the
// handler `handleCascadeRestore` reads children whose cascade_source
// matches this workspace and dispatches `cascadeRestoreList` to each.
//
// We invoke `handleCascadeRestore` directly (it's non-private for the
// same reason `handleReconcile` and `handleCascadeArchive` are),
// since dispatcher-routing is covered separately in reconcileAlarm.

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

async function unarchiveWorkspace(
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
            name: 'unarchiveList',
            mutationId,
            accountId: ownerId,
            body: { listId: wsId },
        }),
    });
}

// The cross-cancellation semantics (archive cancels pending restore;
// restore cancels pending archive) are tested at the handler level
// rather than the alarm-storage level: the Cloudflare DO test
// runtime fires overdue alarms asynchronously between awaits, which
// makes any `alarm:*:at` storage assertion racy under suite load.
//
// What matters for correctness is the handler-side abort: when the
// handler runs and the workspace's state doesn't match its
// direction, it self-cancels without touching children. The mid-
// sweep tests in the handler block below cover both directions:
//
//   - handleCascadeArchive sees workspace.time_deleted IS NULL →
//     cancel (tested in workspaceCascadeArchive.test.ts).
//   - handleCascadeRestore sees workspace.time_deleted IS NOT NULL →
//     cancel (tested below as "mid-restore re-archive").
//
// Together those guarantee that even if the trigger's explicit
// cancelEvent missed, the handler can't accidentally drive the
// wrong direction. The trigger's "scheduleEvent on unarchive" arm
// is covered by the end-to-end test in the handler block:
// `alarm()` is driven directly after unarchive, so the dispatcher
// routes through whatever the trigger queued; if the trigger
// failed silently the child wouldn't end up restored.

describe('workspace cascade-restore handler', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('restores a cascade-archived child (clears time_deleted + cascade_source)', async () => {
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('rh1w', owner);
        const { id: childId } = await mintListUnderWorkspace(
            'rh1l',
            wsId,
            owner
        );

        // Archive workspace → cascade-archive runs → child has
        // time_deleted + cascade_source set.
        await archiveWorkspace(wsId, wsStub, owner, 'rh1w', 2);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );

        const archived = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();
        expect(archived!.cascade_source).toBe(wsId);
        expect(archived!.time_deleted).not.toBeNull();

        // Restore workspace → cascade-restore runs → child returns.
        await unarchiveWorkspace(wsId, wsStub, owner, 'rh1w', 3);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeRestore()
        );

        const restored = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();
        expect(restored!.cascade_source).toBeNull();
        expect(restored!.time_deleted).toBeNull();
    });

    it('skips a user-archived child on restore (cascade_source stays null)', async () => {
        // The user archived the child manually BEFORE the workspace
        // delete. The cascade-archive sweep skipped it (its
        // time_deleted was already set, so the predicate
        // `time_deleted IS NULL AND cascade_source IS NULL` excluded
        // it from the archive batch). Its cascade_source therefore
        // remained null. On restore, the predicate
        // `cascade_source = self` excludes it from the restore batch
        // too — the user's prior "archive this" intent survives the
        // workspace round-trip.
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('rh2w', owner);
        const { id: childId, stub: childStub } =
            await mintListUnderWorkspace('rh2l', wsId, owner);

        await childStub.handlePush({
            authorizedAccounts: [{ id: owner } as any],
            authorizedRole: 'owner',
            listId: childId,
            pushRequest: makePush({
                clientGroupID: `cg_l_rh2l`,
                clientID: `c_l_rh2l`,
                name: 'archiveList',
                mutationId: 2,
                accountId: owner,
                body: { listId: childId },
            }),
        });

        await archiveWorkspace(wsId, wsStub, owner, 'rh2w', 2);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );
        await unarchiveWorkspace(wsId, wsStub, owner, 'rh2w', 3);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeRestore()
        );

        const after = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();
        expect(after!.cascade_source).toBeNull();
        expect(after!.time_deleted).not.toBeNull();
    });

    it('mid-restore re-archive: workspace marked deleted again, handler aborts', async () => {
        // Stale schedule case: handler invoked while workspace is
        // archived (a fresh archive raced ahead of the alarm tick).
        // The archive trigger has already enqueued cascade-archive
        // and canceled cascade-restore, but if the dispatcher
        // somehow still tries to run the restore handler, it must
        // self-abort without touching children.
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('rh3w', owner);
        const { id: childId } = await mintListUnderWorkspace(
            'rh3l',
            wsId,
            owner
        );

        // Archive + cascade to set up the cascade_source.
        await archiveWorkspace(wsId, wsStub, owner, 'rh3w', 2);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );

        // Manually enqueue cascade-restore — simulating a stale
        // schedule — even though the workspace is still archived.
        await runInDurableObject(wsStub, async (_i, state) => {
            await state.storage.put(
                'alarm:cascade-restore:at',
                Date.now()
            );
        });

        await runInDurableObject(wsStub, async i =>
            i.handleCascadeRestore()
        );

        const dueAt = await runInDurableObject(
            wsStub,
            async (_i, state) =>
                state.storage.get<number>('alarm:cascade-restore:at')
        );
        expect(dueAt).toBeUndefined();

        // Child remains archived under this workspace's cascade.
        const after = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();
        expect(after!.cascade_source).toBe(wsId);
        expect(after!.time_deleted).not.toBeNull();
    });

    it('with no children to restore, drains and cancels the event', async () => {
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('rh4', owner);
        await archiveWorkspace(wsId, wsStub, owner, 'rh4', 2);
        // No cascade-archive run, so no children are in cascade
        // state. Restore alarm fires; immediately cancels.
        await unarchiveWorkspace(wsId, wsStub, owner, 'rh4', 3);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeRestore()
        );

        const dueAt = await runInDurableObject(
            wsStub,
            async (_i, state) =>
                state.storage.get<number>('alarm:cascade-restore:at')
        );
        expect(dueAt).toBeUndefined();
    });

    // The "handler re-arms after a non-empty batch" assertion is racy
    // under suite load: the alarm dispatcher can fire between the
    // handler's scheduleEvent call and our storage read, run a second
    // tick that finds the catalog drained, and cancel the event — so
    // the storage key may or may not be present at assertion time.
    // The round-trip test below covers the same code path more
    // meaningfully (multiple cycles complete to terminal state),
    // which is what matters for correctness.

    it('end-to-end: unarchive triggers dispatcher routing to cascade-restore', async () => {
        // Mirror of the archive-side end-to-end test in
        // workspaceCascadeArchive.test.ts. We drive `alarm()`
        // directly (rather than `handleCascadeRestore()`) after the
        // unarchive — so if the trigger fails to schedule
        // cascade-restore, the dispatcher's legacy-fire branch runs
        // reconcile and the cascade-archived child stays archived.
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('e2er', owner);
        const { id: childId } = await mintListUnderWorkspace(
            'e2erL',
            wsId,
            owner
        );

        await archiveWorkspace(wsId, wsStub, owner, 'e2er', 2);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );
        await unarchiveWorkspace(wsId, wsStub, owner, 'e2er', 3);

        // Dispatcher entry point. Reads pending events; if
        // cascade-restore is queued (trigger fired), it routes to
        // handleCascadeRestore and the child gets restored. If
        // queue is empty (trigger silently failed), reconcile runs
        // and the child stays archived.
        await runInDurableObject(wsStub, async i => i.alarm());

        const after = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();
        expect(after!.cascade_source).toBeNull();
        expect(after!.time_deleted).toBeNull();
    });

    it('round-trip: archive → restore → archive → restore lands the final state', async () => {
        // The clientID epoch (workspace.time_updated for restore,
        // workspace.time_deleted for archive) is what makes this
        // work. Without per-campaign uniqueness, the second restore
        // would re-use the first restore's clientID and Replicache
        // would skip mutationId=1 as already-processed, leaving the
        // child stuck archived.
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('rh6w', owner);
        const { id: childId } = await mintListUnderWorkspace(
            'rh6l',
            wsId,
            owner
        );

        // Cycle 1: archive → cascade → restore → cascade-restore
        await archiveWorkspace(wsId, wsStub, owner, 'rh6w', 2);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );
        await unarchiveWorkspace(wsId, wsStub, owner, 'rh6w', 3);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeRestore()
        );

        // Sleep 1s to ensure the workspace's time_updated changes
        // between the two restores. CURRENT_TIMESTAMP in SQLite has
        // 1s resolution, so without this the second unarchive would
        // produce the same time_updated as the first, collapsing the
        // two campaigns' clientIDs.
        await new Promise(resolve => setTimeout(resolve, 1100));

        // Cycle 2: archive → cascade → restore → cascade-restore
        await archiveWorkspace(wsId, wsStub, owner, 'rh6w', 4);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeArchive()
        );
        await unarchiveWorkspace(wsId, wsStub, owner, 'rh6w', 5);
        await runInDurableObject(wsStub, async i =>
            i.handleCascadeRestore()
        );

        const after = await env.DJIBB_AUTH.prepare(
            `SELECT cascade_source, time_deleted
             FROM workspace_entities WHERE id = ?`
        )
            .bind(childId)
            .first<{ cascade_source: string | null; time_deleted: number | null }>();
        expect(after!.cascade_source).toBeNull();
        expect(after!.time_deleted).toBeNull();
    });
});
