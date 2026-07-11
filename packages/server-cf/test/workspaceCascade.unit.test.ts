// ADR 0026 series 1: direct unit tests for the workspace cascade free
// functions carved out of the DO into `workspace/cascade.ts`. The
// external DO tests (workspaceCascadeArchive/Restore, hardDelete, ...)
// drive the thin DO delegators end-to-end and stay the regression
// signal; these tests reach the free functions directly with a fake
// in-memory `AlarmScheduler` + a stub `DJIBB_LIST` namespace, so we can
// assert re-arm behavior the ADR flagged as "miserable to construct
// externally": partial child-push failure, empty batch, restore-race
// abort, and the hard-delete D1-purge failure that must NOT tear down
// the DO.
//
// We still obtain a real miniflare `SqlStorage` (the workspace's own
// soft-deleted row) and a real `DJIBB_AUTH` D1 (the child catalog) by
// minting/archiving a workspace DO and running the free function inside
// `runInDurableObject`, where `i.sql` and the D1 binding are live.

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import {
    applyWorkspacePostCommit,
    cascadeArchiveSweep,
    hardDeleteSweep,
    harddeleteTransition,
    isCascadeArchiveTrigger,
    isCascadeRestoreTrigger,
    type AlarmScheduler,
} from '../src/workspace/cascade';
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
): Promise<string> {
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
    return id;
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

function fakeScheduler() {
    const scheduled: Array<{ name: string; dueAt: number }> = [];
    const canceled: string[] = [];
    const scheduler: AlarmScheduler = {
        schedule: async (name, dueAt) => {
            scheduled.push({ name, dueAt });
        },
        cancel: async (name) => {
            canceled.push(name);
        },
    };
    return { scheduler, scheduled, canceled };
}

// A stub `DJIBB_LIST` whose child `handlePush` records the child id and
// optionally throws for one specific child — the "one child push throws"
// partial-failure shape. It never touches D1, so child catalog rows are
// untouched by these pushes (unlike the real child DOs).
function stubListNs(failChildId?: string) {
    const pushed: string[] = [];
    const ns = {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: (id: unknown) => ({
            handlePush: async () => {
                pushed.push(id as string);
                if (id === failChildId) {
                    throw new Error(`stub child push boom for "${id}"`);
                }
            },
        }),
    } as unknown as DurableObjectNamespace;
    return { ns, pushed };
}

describe('cascadeArchiveSweep (free function)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('partial failure: one child push throws, sweep still re-arms and leaves the failed child', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintWorkspace('paf-w', owner);
        const childA = await mintListUnderWorkspace('paf-a', wsId, owner);
        const childB = await mintListUnderWorkspace('paf-b', wsId, owner);
        await archiveWorkspace(wsId, stub, owner, 'paf-w', 2);

        const { scheduler, scheduled, canceled } = fakeScheduler();
        const { ns, pushed } = stubListNs(childA);

        await runInDurableObject(stub, async (i) =>
            cascadeArchiveSweep({
                sql: i.sql,
                d1: env.DJIBB_AUTH,
                listNs: ns,
                scheduler,
                batchSize: 10,
            })
        );

        // Both children attempted (the throw on childA is caught, so the
        // loop still reaches childB).
        expect(pushed.sort()).toEqual([childA, childB].sort());
        // Non-empty batch → re-arm cascade-archive for the next tick.
        expect(scheduled.map((s) => s.name)).toContain('cascade-archive');
        expect(canceled).not.toContain('cascade-archive');
        // The stub never wrote D1, so both children stay eligible for the
        // next sweep — the failed child isn't lost.
        const eligible = await env.DJIBB_AUTH.prepare(
            `SELECT COUNT(*) AS n FROM workspace_entities
             WHERE workspace_id = ?
               AND time_deleted IS NULL
               AND cascade_source IS NULL`
        )
            .bind(wsId)
            .first<{ n: number }>();
        expect(eligible!.n).toBe(2);
    });

    it('empty batch: no eligible children → cancels cascade-archive, no re-arm', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintWorkspace('emp-w', owner);
        await archiveWorkspace(wsId, stub, owner, 'emp-w', 2);

        const { scheduler, scheduled, canceled } = fakeScheduler();
        const { ns, pushed } = stubListNs();

        await runInDurableObject(stub, async (i) =>
            cascadeArchiveSweep({
                sql: i.sql,
                d1: env.DJIBB_AUTH,
                listNs: ns,
                scheduler,
                batchSize: 10,
            })
        );

        expect(pushed).toEqual([]);
        expect(canceled).toContain('cascade-archive');
        expect(scheduled).toEqual([]);
    });

    it('restore race: workspace not soft-deleted → cancels without pushing any child', async () => {
        const owner = newId('account');
        // Mint a workspace with a child but do NOT archive it: the
        // sweep's own-row check sees time_deleted IS NULL and aborts,
        // exactly as a restoreWorkspace racing ahead of the tick would.
        const { wsId, stub } = await mintWorkspace('rr-w', owner);
        await mintListUnderWorkspace('rr-a', wsId, owner);

        const { scheduler, scheduled, canceled } = fakeScheduler();
        const { ns, pushed } = stubListNs();

        await runInDurableObject(stub, async (i) =>
            cascadeArchiveSweep({
                sql: i.sql,
                d1: env.DJIBB_AUTH,
                listNs: ns,
                scheduler,
                batchSize: 10,
            })
        );

        expect(pushed).toEqual([]);
        expect(canceled).toContain('cascade-archive');
        expect(scheduled).toEqual([]);
    });
});

describe('hardDeleteSweep (free function)', () => {
    beforeAll(async () => {
        await ensureD1Schema();
    });
    beforeEach(async () => {
        await resetWorkspaceData();
    });

    it('D1-purge failure: re-arms at backoff, does NOT deleteAll, returns false', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintWorkspace('hd-fail', owner);
        await archiveWorkspace(wsId, stub, owner, 'hd-fail', 2);

        const { scheduler, scheduled, canceled } = fakeScheduler();
        // A broken D1 binding makes DeleteEntityRow throw inside runD1.
        const brokenD1 = {} as unknown as D1Database;
        let deleteAllCalled = false;

        const terminal = await runInDurableObject(stub, async (i) =>
            hardDeleteSweep({
                sql: i.sql,
                d1: brokenD1,
                scheduler,
                deleteAllStorage: async () => {
                    deleteAllCalled = true;
                },
                retryBackoffMs: 60_000,
            })
        );

        expect(terminal).toBe(false);
        expect(deleteAllCalled).toBe(false);
        // Re-armed harddelete at the backoff, not canceled.
        expect(scheduled.map((s) => s.name)).toContain('harddelete');
        expect(canceled).not.toContain('harddelete');
    });

    it('success: purges the catalog row, deletes all storage, returns true (terminal)', async () => {
        const owner = newId('account');
        const { wsId, stub } = await mintWorkspace('hd-ok', owner);
        await archiveWorkspace(wsId, stub, owner, 'hd-ok', 2);

        const { scheduler } = fakeScheduler();
        let deleteAllCalled = false;

        const terminal = await runInDurableObject(stub, async (i) =>
            hardDeleteSweep({
                sql: i.sql,
                d1: env.DJIBB_AUTH,
                scheduler,
                deleteAllStorage: async () => {
                    deleteAllCalled = true;
                },
            })
        );

        expect(terminal).toBe(true);
        expect(deleteAllCalled).toBe(true);
        const row = await env.DJIBB_AUTH.prepare(
            `SELECT id FROM workspace_entities WHERE id = ?`
        )
            .bind(wsId)
            .first();
        expect(row).toBeNull();
    });
});

// -------------------------------------------------------------------------
// Slice 2: push-path trigger predicates + the post-commit workspace tail.
// These are pure (no DO, no D1, no miniflare) — the whole point of the
// carve is that the tail's flag/scheduler interaction is now assertable
// without constructing a DO. We drive it with a fake scheduler + a mint
// spy.
// -------------------------------------------------------------------------

const WS = 'w/aaaaaaaaaaaaaaaaaaaaaaa';
const LIST = 'l/aaaaaaaaaaaaaaaaaaaaaaa';

describe('cascade trigger predicates', () => {
    it('isCascadeArchiveTrigger: archiveList/startFresh on a workspace id only', () => {
        expect(isCascadeArchiveTrigger('archiveList', WS)).toBe(true);
        expect(isCascadeArchiveTrigger('startFresh', WS)).toBe(true);
        // Not a workspace id → self-contained list/template archive.
        expect(isCascadeArchiveTrigger('archiveList', LIST)).toBe(false);
        // Wrong mutation.
        expect(isCascadeArchiveTrigger('unarchiveList', WS)).toBe(false);
    });

    it('isCascadeRestoreTrigger: unarchiveList on a workspace id only', () => {
        expect(isCascadeRestoreTrigger('unarchiveList', WS)).toBe(true);
        expect(isCascadeRestoreTrigger('unarchiveList', LIST)).toBe(false);
        expect(isCascadeRestoreTrigger('archiveList', WS)).toBe(false);
    });

    it('harddeleteTransition: arm on archives, clear on restores, null otherwise', () => {
        expect(harddeleteTransition('archiveList')).toBe('arm');
        expect(harddeleteTransition('cascadeArchiveList')).toBe('arm');
        expect(harddeleteTransition('startFresh')).toBe('arm');
        expect(harddeleteTransition('unarchiveList')).toBe('clear');
        expect(harddeleteTransition('cascadeRestoreList')).toBe('clear');
        expect(harddeleteTransition('renameList')).toBeNull();
    });
});

// A fake scheduler that records the ordered sequence of schedule/cancel
// calls so we can assert the tail's cancel-before-schedule ordering.
function orderedScheduler() {
    const calls: Array<{ op: 'schedule' | 'cancel'; name: string }> = [];
    const scheduler: AlarmScheduler = {
        schedule: async (name) => {
            calls.push({ op: 'schedule', name });
        },
        cancel: async (name) => {
            calls.push({ op: 'cancel', name });
        },
    };
    return { scheduler, calls };
}

describe('applyWorkspacePostCommit', () => {
    it('startFresh: cancels restore, schedules archive, mints replacement, arms harddelete', async () => {
        const { scheduler, calls } = orderedScheduler();
        const minted: Array<{ accountId: string; displayName: string | null }> =
            [];

        await applyWorkspacePostCommit(
            {
                scheduler,
                hardDeleteDelayMs: 1000,
                mintPersonalWorkspace: async (actor) => {
                    minted.push(actor);
                },
            },
            {
                cascadeArchiveTriggered: true,
                cascadeRestoreTriggered: false,
                harddelete: 'arm',
                startFresh: { accountId: 'acc_1', displayName: 'Ada' },
                listId: WS,
            }
        );

        // Archive trigger cancels any racing restore before scheduling.
        expect(calls).toEqual([
            { op: 'cancel', name: 'cascade-restore' },
            { op: 'schedule', name: 'cascade-archive' },
            { op: 'schedule', name: 'harddelete' },
        ]);
        // Replacement personal workspace minted for the actor.
        expect(minted).toEqual([{ accountId: 'acc_1', displayName: 'Ada' }]);
    });

    it('restore trigger: cancels archive, schedules restore, clears harddelete, no mint', async () => {
        const { scheduler, calls } = orderedScheduler();
        let mintCalled = false;

        await applyWorkspacePostCommit(
            {
                scheduler,
                hardDeleteDelayMs: 1000,
                mintPersonalWorkspace: async () => {
                    mintCalled = true;
                },
            },
            {
                cascadeArchiveTriggered: false,
                cascadeRestoreTriggered: true,
                harddelete: 'clear',
                startFresh: null,
                listId: WS,
            }
        );

        expect(calls).toEqual([
            { op: 'cancel', name: 'cascade-archive' },
            { op: 'schedule', name: 'cascade-restore' },
            { op: 'cancel', name: 'harddelete' },
        ]);
        expect(mintCalled).toBe(false);
    });

    it('swallows a mint failure and still arms the harddelete clock', async () => {
        const { scheduler, calls } = orderedScheduler();

        await expect(
            applyWorkspacePostCommit(
                {
                    scheduler,
                    hardDeleteDelayMs: 1000,
                    mintPersonalWorkspace: async () => {
                        throw new Error('mint boom');
                    },
                },
                {
                    cascadeArchiveTriggered: true,
                    cascadeRestoreTriggered: false,
                    harddelete: 'arm',
                    startFresh: { accountId: 'acc_2', displayName: null },
                    listId: WS,
                }
            )
        ).resolves.toBeUndefined();

        // The mint threw but the harddelete arm still ran (later block).
        expect(calls).toContainEqual({ op: 'schedule', name: 'harddelete' });
    });

    it('no flags raised: does nothing', async () => {
        const { scheduler, calls } = orderedScheduler();
        let mintCalled = false;

        await applyWorkspacePostCommit(
            {
                scheduler,
                hardDeleteDelayMs: 1000,
                mintPersonalWorkspace: async () => {
                    mintCalled = true;
                },
            },
            {
                cascadeArchiveTriggered: false,
                cascadeRestoreTriggered: false,
                harddelete: null,
                startFresh: null,
                listId: WS,
            }
        );

        expect(calls).toEqual([]);
        expect(mintCalled).toBe(false);
    });
});
