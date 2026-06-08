// ADR 0011 §Step 10b-clock / ADR 0008: tests for the per-DO hard-delete
// clock. Three concerns covered separately:
//
//   1. Trigger arm — a soft-delete mutation lands a `harddelete` alarm
//      event ~30d in the future. Symmetric across user-driven
//      (`archiveList`) and system-driven (`cascadeArchiveList`) flavors.
//   2. Trigger clear — restore mutations cancel any pending harddelete.
//   3. Handler — `handleHardDelete` purges the D1 catalog row and wipes
//      the DO storage when the entity is still soft-deleted; aborts and
//      cancels when the row has been restored (safety net against a
//      stale event).
//
// We invoke `handleHardDelete` directly for the handler-only tests, and
// drive `alarm()` for the end-to-end test (with `HARD_DELETE_DELAY_MS`
// monkey-patched to 0 so the alarm fires immediately).

import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
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

async function archiveList(
    id: string,
    stub: DurableObjectStub<DjibbList>,
    ownerId: string,
    suffix: string,
    mutationId: number,
    isWorkspace = false
): Promise<void> {
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'owner',
        listId: id,
        pushRequest: makePush({
            clientGroupID: isWorkspace ? `cg_${suffix}` : `cg_l_${suffix}`,
            clientID: isWorkspace ? `c_${suffix}` : `c_l_${suffix}`,
            name: 'archiveList',
            mutationId,
            accountId: ownerId,
            body: { listId: id },
        }),
    });
}

async function unarchiveList(
    id: string,
    stub: DurableObjectStub<DjibbList>,
    ownerId: string,
    suffix: string,
    mutationId: number,
    isWorkspace = false
): Promise<void> {
    await stub.handlePush({
        authorizedAccounts: [{ id: ownerId } as any],
        authorizedRole: 'owner',
        listId: id,
        pushRequest: makePush({
            clientGroupID: isWorkspace ? `cg_${suffix}` : `cg_l_${suffix}`,
            clientID: isWorkspace ? `c_${suffix}` : `c_l_${suffix}`,
            name: 'unarchiveList',
            mutationId,
            accountId: ownerId,
            body: { listId: id },
        }),
    });
}

describe('hard-delete trigger arm/clear', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('archiving a workspace arms harddelete ~30d out', async () => {
        const owner = newId('account');
        const before = Date.now();
        const { wsId, stub } = await mintWorkspace('ta1', owner);
        await archiveList(wsId, stub, owner, 'ta1', 2, true);
        const after = Date.now();

        const dueAt = await runInDurableObject(stub, async (_i, state) =>
            state.storage.get<number>('alarm:harddelete:at')
        );
        expect(dueAt).toBeDefined();
        // Window: [before + 30d, after + 30d]. Inclusive on both sides.
        expect(dueAt!).toBeGreaterThanOrEqual(
            before + DjibbList.HARD_DELETE_DELAY_MS
        );
        expect(dueAt!).toBeLessThanOrEqual(
            after + DjibbList.HARD_DELETE_DELAY_MS
        );
    });

    it('archiving a list arms harddelete on its own DO', async () => {
        // Hard-delete clock isn't workspace-only: every soft-deleted
        // entity gets the 30d countdown, list/template included.
        const owner = newId('account');
        const { wsId } = await mintWorkspace('ta2w', owner);
        const { id: childId, stub: childStub } =
            await mintListUnderWorkspace('ta2l', wsId, owner);

        await archiveList(childId, childStub, owner, 'ta2l', 2);

        const dueAt = await runInDurableObject(
            childStub,
            async (_i, state) =>
                state.storage.get<number>('alarm:harddelete:at')
        );
        expect(dueAt).toBeDefined();
    });

    it('unarchiving clears the harddelete event', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintWorkspace('tc1', owner);
        await archiveList(wsId, stub, owner, 'tc1', 2, true);

        // Confirm armed first so the assertion-on-clear is meaningful.
        const armed = await runInDurableObject(stub, async (_i, state) =>
            state.storage.get<number>('alarm:harddelete:at')
        );
        expect(armed).toBeDefined();

        await unarchiveList(wsId, stub, owner, 'tc1', 3, true);

        const cleared = await runInDurableObject(stub, async (_i, state) =>
            state.storage.get<number>('alarm:harddelete:at')
        );
        expect(cleared).toBeUndefined();
    });

    it('cascade-archive of a child arms its own harddelete (E2E)', async () => {
        // The system-role `cascadeArchiveList` mutator runs the same
        // _handlePush trigger path as user `archiveList`. Drive the
        // workspace cascade end-to-end and verify the child DO ends
        // up with its own armed clock.
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('tcc', owner);
        const { id: childId, stub: childStub } =
            await mintListUnderWorkspace('tccL', wsId, owner);

        await archiveList(wsId, wsStub, owner, 'tcc', 2, true);
        // Drive dispatcher → handleCascadeArchive → child's cascadeArchiveList.
        await runInDurableObject(wsStub, async i => i.alarm());

        const dueAt = await runInDurableObject(
            childStub,
            async (_i, state) =>
                state.storage.get<number>('alarm:harddelete:at')
        );
        expect(dueAt).toBeDefined();
    });

    it('cascade-restore of a child clears its harddelete (E2E)', async () => {
        // Symmetric: a workspace's `unarchiveList` enqueues
        // cascade-restore; each child gets `cascadeRestoreList`, which
        // flips the harddelete tracker to 'clear'.
        const owner = newId('account');
        const { wsId, stub: wsStub } = await mintWorkspace('tcr', owner);
        const { id: childId, stub: childStub } =
            await mintListUnderWorkspace('tcrL', wsId, owner);

        await archiveList(wsId, wsStub, owner, 'tcr', 2, true);
        await runInDurableObject(wsStub, async i => i.alarm()); // cascade-archive
        // Child's harddelete is now armed (covered by prior test). Now flip.
        await unarchiveList(wsId, wsStub, owner, 'tcr', 3, true);
        await runInDurableObject(wsStub, async i => i.alarm()); // cascade-restore

        const cleared = await runInDurableObject(
            childStub,
            async (_i, state) =>
                state.storage.get<number>('alarm:harddelete:at')
        );
        expect(cleared).toBeUndefined();
    });

    it('archive→restore→archive lands a fresh harddelete dueAt', async () => {
        // Defensive against state staleness: re-arming after clear
        // should produce a new dueAt, not a cached one from the first
        // archive. The replicache mutation IDs alternate cleanly
        // because we reuse the same clientID.
        const owner = newId('account');
        const { wsId, stub } = await mintWorkspace('trtra', owner);

        await archiveList(wsId, stub, owner, 'trtra', 2, true);
        const first = await runInDurableObject(stub, async (_i, state) =>
            state.storage.get<number>('alarm:harddelete:at')
        );
        expect(first).toBeDefined();

        await unarchiveList(wsId, stub, owner, 'trtra', 3, true);
        // SQLite CURRENT_TIMESTAMP has 1s resolution; sleep so the
        // re-archive lands a fresh `time_deleted` and the harddelete
        // dueAt is observably later.
        await new Promise(r => setTimeout(r, 1100));
        await archiveList(wsId, stub, owner, 'trtra', 4, true);

        const second = await runInDurableObject(stub, async (_i, state) =>
            state.storage.get<number>('alarm:harddelete:at')
        );
        expect(second).toBeDefined();
        expect(second!).toBeGreaterThan(first!);
    });
});

describe('hard-delete handler', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('purges D1 row and DO storage when entity is still soft-deleted', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintWorkspace('hd1', owner);
        await archiveList(wsId, stub, owner, 'hd1', 2, true);

        // Confirm D1 row exists pre-handler (soft-deleted state).
        const beforeRow = await env.DJIBB_AUTH.prepare(
            `SELECT id, time_deleted FROM workspace_entities WHERE id = ?`
        )
            .bind(wsId)
            .first();
        expect(beforeRow).not.toBeNull();
        expect(beforeRow!.time_deleted).not.toBeNull();

        await runInDurableObject(stub, async i => i.handleHardDelete());

        // D1 row gone.
        const afterRow = await env.DJIBB_AUTH.prepare(
            `SELECT id FROM workspace_entities WHERE id = ?`
        )
            .bind(wsId)
            .first();
        expect(afterRow).toBeNull();

        // DO storage emptied: no list_elements rows, no alarm keys.
        const storageEmpty = await runInDurableObject(
            stub,
            async (_i, state) => {
                const list = await state.storage.list();
                return list.size;
            }
        );
        expect(storageEmpty).toBe(0);
    });

    it('aborts when entity has been restored (safety net)', async () => {
        // Stale event scenario: the unarchive's `cancelEvent` should
        // have dropped this key, but suppose it didn't (network blip,
        // race). The handler reads `time_deleted` and self-aborts
        // without touching D1 or DO storage.
        const owner = newId('account');
        const { wsId, stub } = await mintWorkspace('hd2', owner);
        await archiveList(wsId, stub, owner, 'hd2', 2, true);
        await unarchiveList(wsId, stub, owner, 'hd2', 3, true);

        // Manually re-plant a stale harddelete event to simulate the
        // race. The handler should see `time_deleted IS NULL` and
        // cancel it.
        await runInDurableObject(stub, async (_i, state) => {
            await state.storage.put('alarm:harddelete:at', Date.now());
        });

        await runInDurableObject(stub, async i => i.handleHardDelete());

        // D1 row still present and live.
        const row = await env.DJIBB_AUTH.prepare(
            `SELECT id, time_deleted FROM workspace_entities WHERE id = ?`
        )
            .bind(wsId)
            .first<{ id: string; time_deleted: number | null }>();
        expect(row).not.toBeNull();
        expect(row!.time_deleted).toBeNull();

        // Stale event canceled.
        const dueAt = await runInDurableObject(stub, async (_i, state) =>
            state.storage.get<number>('alarm:harddelete:at')
        );
        expect(dueAt).toBeUndefined();
    });

    it('end-to-end: armed clock fires via alarm() and self-destructs', async () => {
        // Patch the delay to 0 so the scheduled event is immediately
        // due. Then drive `alarm()` and verify the dispatcher routes to
        // `handleHardDelete` (the only signals visible from the outside
        // are: DO storage empty, D1 row gone).
        const original = DjibbList.HARD_DELETE_DELAY_MS;
        DjibbList.HARD_DELETE_DELAY_MS = 0;
        try {
            const owner = newId('account');
            const { wsId, stub } = await mintWorkspace('hde2e', owner);
            await archiveList(wsId, stub, owner, 'hde2e', 2, true);

            await runInDurableObject(stub, async i => i.alarm());

            const row = await env.DJIBB_AUTH.prepare(
                `SELECT id FROM workspace_entities WHERE id = ?`
            )
                .bind(wsId)
                .first();
            expect(row).toBeNull();

            const storageSize = await runInDurableObject(
                stub,
                async (_i, state) => (await state.storage.list()).size
            );
            expect(storageSize).toBe(0);
        } finally {
            DjibbList.HARD_DELETE_DELAY_MS = original;
        }
    });

    it('in-tick: a co-scheduled reconcile does not run after hard-delete wipes the DO', async () => {
        // Regression for the in-tick race (a5dc83f). `alarm()` reads all
        // due events up front, then loops. `harddelete` sorts before
        // `reconcile`, so it runs first and `deleteAll()`s the DO
        // mid-loop. Without the terminal-stop, the loop would then run
        // `reconcile` against the now-schemaless DO: `getEntityId` is
        // strict and throws "no such table" (rejecting `alarm()`), and a
        // re-arm would resurrect the storage we just wiped.
        const original = DjibbList.HARD_DELETE_DELAY_MS;
        DjibbList.HARD_DELETE_DELAY_MS = 0;
        try {
            const owner = newId('account');
            const { wsId, stub } = await mintWorkspace('hdrace', owner);
            await archiveList(wsId, stub, owner, 'hdrace', 2, true);

            // Force the (already-armed) reconcile into the past so both
            // it and the now-due harddelete fire in the same alarm tick.
            await runInDurableObject(stub, async (_i, state) => {
                await state.storage.put('alarm:reconcile:at', Date.now() - 1);
            });

            // Must resolve. A leaked reconcile against the wiped DO would
            // throw "no such table" and reject here.
            await expect(
                runInDurableObject(stub, async i => i.alarm())
            ).resolves.toBeUndefined();

            // DO fully self-destructed and stayed wiped — reconcile
            // neither resurrected storage nor re-armed an alarm.
            const storageSize = await runInDurableObject(
                stub,
                async (_i, state) => (await state.storage.list()).size
            );
            expect(storageSize).toBe(0);

            const row = await env.DJIBB_AUTH.prepare(
                `SELECT id FROM workspace_entities WHERE id = ?`
            )
                .bind(wsId)
                .first();
            expect(row).toBeNull();
        } finally {
            DjibbList.HARD_DELETE_DELAY_MS = original;
        }
    });
});
