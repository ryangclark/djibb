import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import type { PushRequestV1 } from 'replicache';

import { DjibbList } from '../src/list/durable_object';
import { IdTypes } from '../src/id';
import {
    ensureD1Schema,
    resetWorkspaceData,
    withMissingEntitiesTable,
} from './helpers/d1';

// ADR 0007: D1 reconciliation sweeper via DO alarms. Verifies the
// per-DO `handleReconcile()` handler (skip-when-matched, emit-on-
// drift) and the bootstrap that schedules the first alarm on push.
//
// ADR 0011 §Step 10a.2: `alarm()` is now a multi-event dispatcher
// that routes due events to handlers. Reconcile-handler tests call
// `handleReconcile()` directly so they exercise the handler without
// having to satisfy the dispatcher's "is this event past-due?"
// filter; dispatcher-level routing has its own describe block.

function getListStub(suffix: string) {
    const prefixed = `${IdTypes.list}/${suffix.padEnd(21, 'a').slice(0, 21)}`;
    const id = env.DJIBB_LIST.idFromName(prefixed);
    return {
        listId: prefixed,
        stub: env.DJIBB_LIST.get(id) as DurableObjectStub<DjibbList>,
    };
}

function makeInitListPush({
    clientGroupID,
    clientID,
    listId,
}: {
    clientGroupID: string;
    clientID: string;
    listId: string;
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
                    accountId: null,
                    listId,
                    timestamp_client: new Date().toISOString(),
                    workspaceId: null,
                },
            },
        ],
    };
}

async function readD1Version(id: string): Promise<number | null> {
    const row = await env.DJIBB_AUTH.prepare(
        'SELECT version FROM workspace_entities WHERE id = ?',
    )
        .bind(id)
        .first<{ version: number }>();
    return row?.version ?? null;
}

async function readD1Name(id: string): Promise<string | null> {
    const row = await env.DJIBB_AUTH.prepare(
        'SELECT name FROM workspace_entities WHERE id = ?',
    )
        .bind(id)
        .first<{ name: string | null }>();
    return row?.name ?? null;
}

async function readDoVersion(stub: DurableObjectStub<DjibbList>, id: string) {
    return runInDurableObject(stub, async (_i, state) =>
        state.storage.sql
            .exec(`SELECT version FROM list_elements WHERE id = ?;`, id)
            .one(),
    ) as Promise<{ version: number }>;
}

beforeAll(async () => {
    await ensureD1Schema();
});

beforeEach(async () => {
    await resetWorkspaceData();
});

describe('reconciliation alarm bootstrap', () => {
    it('schedules an alarm at healthy cadence after first push', async () => {
        const { listId, stub } = getListStub('boot1');
        const before = Date.now();

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_boot_1',
                clientID: 'c_boot_1',
                listId,
            }),
        });

        const after = Date.now();
        const scheduledAt = await runInDurableObject(stub, (_i, state) =>
            state.storage.getAlarm(),
        );

        expect(scheduledAt).not.toBeNull();
        // Scheduled ~24h from now (within the push handler's wall time).
        const lo = before + DjibbList.RECONCILE_HEALTHY_MS;
        const hi = after + DjibbList.RECONCILE_HEALTHY_MS;
        expect(scheduledAt!).toBeGreaterThanOrEqual(lo);
        expect(scheduledAt!).toBeLessThanOrEqual(hi);
    });

    it('is idempotent — a second push does not reschedule', async () => {
        const { listId, stub } = getListStub('boot2');
        const baseArgs = {
            authorizedAccounts: [],
            authorizedRole: 'ownerless' as const,
            listId,
        };

        await stub.handlePush({
            ...baseArgs,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_boot_2',
                clientID: 'c_boot_2',
                listId,
            }),
        });
        const firstAlarmAt = await runInDurableObject(stub, (_i, state) =>
            state.storage.getAlarm(),
        );

        // Same client, follow-up push (renameList — touches metadata
        // so it exercises the same tail path the bootstrap lives in).
        await stub.handlePush({
            ...baseArgs,
            pushRequest: {
                profileID: 'p_test',
                clientGroupID: 'cg_boot_2',
                pushVersion: 1,
                schemaVersion: '1',
                mutations: [
                    {
                        clientID: 'c_boot_2',
                        id: 2,
                        name: 'renameList',
                        timestamp: Date.now(),
                        args: {
                            accountId: null,
                            timestamp_client: new Date().toISOString(),
                            listId,
                            name: 'renamed',
                        },
                    },
                ],
            },
        });
        const secondAlarmAt = await runInDurableObject(stub, (_i, state) =>
            state.storage.getAlarm(),
        );

        expect(secondAlarmAt).toBe(firstAlarmAt);
    });
});

describe('reconciliation alarm handler', () => {
    it('skips emit and re-arms at healthy when D1 already matches DO version', async () => {
        const { listId, stub } = getListStub('skip1');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_skip_1',
                clientID: 'c_skip_1',
                listId,
            }),
        });

        // Post-push: DO version = D1 version (synchronous emit ran).
        const { version: doVersion } = await readDoVersion(stub, listId);
        expect(await readD1Version(listId)).toBe(doVersion);

        // Mark D1 to detect any spurious write: stash the post-push
        // time_updated. If the alarm wrote, time_updated would change.
        const before = await env.DJIBB_AUTH.prepare(
            'SELECT time_updated FROM workspace_entities WHERE id = ?',
        )
            .bind(listId)
            .first<{ time_updated: number }>();

        // Wait a clock tick so any UPSERT would land a later
        // time_updated than what's in D1.
        await new Promise(r => setTimeout(r, 1100));

        const beforeAlarm = Date.now();
        await runInDurableObject(stub, (instance, _state) => instance.handleReconcile());
        const afterAlarm = Date.now();

        const after = await env.DJIBB_AUTH.prepare(
            'SELECT time_updated FROM workspace_entities WHERE id = ?',
        )
            .bind(listId)
            .first<{ time_updated: number }>();
        expect(after?.time_updated).toBe(before?.time_updated);

        // Re-armed at healthy cadence.
        const next = await runInDurableObject(stub, (_i, state) =>
            state.storage.getAlarm(),
        );
        expect(next).not.toBeNull();
        expect(next!).toBeGreaterThanOrEqual(
            beforeAlarm + DjibbList.RECONCILE_HEALTHY_MS,
        );
        expect(next!).toBeLessThanOrEqual(
            afterAlarm + DjibbList.RECONCILE_HEALTHY_MS,
        );
    });

    it('emits when D1 row is missing entirely', async () => {
        const { listId, stub } = getListStub('drift1');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_drift_1',
                clientID: 'c_drift_1',
                listId,
            }),
        });

        // Simulate worst-case drift: the post-commit emit lost the
        // row entirely (e.g. D1 was unreachable during the push).
        await env.DJIBB_AUTH.prepare(
            'DELETE FROM workspace_entities WHERE id = ?',
        )
            .bind(listId)
            .run();
        expect(await readD1Version(listId)).toBeNull();

        await runInDurableObject(stub, (instance, _state) => instance.handleReconcile());

        const { version: doVersion } = await readDoVersion(stub, listId);
        expect(await readD1Version(listId)).toBe(doVersion);
    });

    it('emits when D1 version trails DO version', async () => {
        const { listId, stub } = getListStub('drift2');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_drift_2',
                clientID: 'c_drift_2',
                listId,
            }),
        });

        // Simulate a dropped emit: roll D1 back to a stale version
        // (and stale name, so we can observe the repair).
        await env.DJIBB_AUTH.prepare(
            'UPDATE workspace_entities SET version = 0, name = ? WHERE id = ?',
        )
            .bind('stale-name', listId)
            .run();
        expect(await readD1Version(listId)).toBe(0);
        expect(await readD1Name(listId)).toBe('stale-name');

        await runInDurableObject(stub, (instance, _state) => instance.handleReconcile());

        const { version: doVersion } = await readDoVersion(stub, listId);
        expect(await readD1Version(listId)).toBe(doVersion);
        // Stale name overwritten by the DO's current name (empty by default).
        expect(await readD1Name(listId)).not.toBe('stale-name');
    });

    it('persists a retry interval and re-arms at backoff when the emit throws', async () => {
        const { listId, stub } = getListStub('retry2');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_retry_2',
                clientID: 'c_retry_2',
                listId,
            }),
        });

        // Force drift so the alarm path attempts an emit (rather
        // than taking the skip-when-matched branch). Without this
        // the alarm would see D1 == DO version and never call
        // emitEntitySnapshot at all.
        await env.DJIBB_AUTH.prepare(
            'UPDATE workspace_entities SET version = 0 WHERE id = ?',
        )
            .bind(listId)
            .run();

        const beforeAlarm = Date.now();

        await withMissingEntitiesTable(async () => {
            await runInDurableObject(stub, (instance, _state) =>
                instance.handleReconcile(),
            );
        });

        const afterAlarm = Date.now();

        // Retry interval was persisted (starts at the initial
        // backoff per ADR 0007).
        const retry = await runInDurableObject(stub, (_i, state) =>
            state.storage.get<number>(DjibbList.RECONCILE_RETRY_KEY),
        );
        expect(retry).toBe(DjibbList.RECONCILE_RETRY_INITIAL_MS);

        // Alarm re-armed at the retry interval, not the healthy
        // cadence.
        const next = await runInDurableObject(stub, (_i, state) =>
            state.storage.getAlarm(),
        );
        expect(next).not.toBeNull();
        expect(next!).toBeGreaterThanOrEqual(
            beforeAlarm + DjibbList.RECONCILE_RETRY_INITIAL_MS,
        );
        expect(next!).toBeLessThanOrEqual(
            afterAlarm + DjibbList.RECONCILE_RETRY_INITIAL_MS,
        );
    });

    it('clears any persisted retry interval after a successful run', async () => {
        const { listId, stub } = getListStub('retry1');

        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_retry_1',
                clientID: 'c_retry_1',
                listId,
            }),
        });

        // Seed a stale retry state as if the previous alarm had
        // failed. A successful alarm must clear it.
        await runInDurableObject(stub, (_i, state) =>
            state.storage.put(DjibbList.RECONCILE_RETRY_KEY, 999_999),
        );

        await runInDurableObject(stub, (instance, _state) => instance.handleReconcile());

        const stillThere = await runInDurableObject(stub, (_i, state) =>
            state.storage.get<number>(DjibbList.RECONCILE_RETRY_KEY),
        );
        expect(stillThere).toBeUndefined();
    });
});

// ADR 0011 §Step 10a.2: multi-event alarm dispatcher. Routes any
// `alarm:<name>:at` storage key whose due time has passed to its
// handler, then leaves the alarm armed at the next earliest pending
// event. The "no pending events" branch falls back to running
// reconcile so a DO scheduled before the dispatcher refactor still
// gets reconcile coverage on its first post-deploy fire.
describe('alarm dispatcher (multi-event)', () => {
    it('fires reconcile when its event is past-due', async () => {
        const { listId, stub } = getListStub('disp1');
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_disp_1',
                clientID: 'c_disp_1',
                listId,
            }),
        });

        // Force the reconcile event into the past so the dispatcher
        // fires it. Drift the catalog so the handler actually emits
        // (gives us a side effect to assert on).
        await env.DJIBB_AUTH.prepare(
            'UPDATE workspace_entities SET version = 0 WHERE id = ?',
        )
            .bind(listId)
            .run();
        await runInDurableObject(stub, (_i, state) =>
            state.storage.put('alarm:reconcile:at', Date.now() - 1),
        );

        await runInDurableObject(stub, (instance, _state) => instance.alarm());

        const { version: doVersion } = await readDoVersion(stub, listId);
        expect(await readD1Version(listId)).toBe(doVersion);
    });

    it('skips events whose due time has not yet arrived', async () => {
        const { listId, stub } = getListStub('disp2');
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_disp_2',
                clientID: 'c_disp_2',
                listId,
            }),
        });

        // Drift the catalog so reconcile WOULD emit if it ran.
        await env.DJIBB_AUTH.prepare(
            'UPDATE workspace_entities SET version = 0 WHERE id = ?',
        )
            .bind(listId)
            .run();
        const before = await readD1Version(listId);
        expect(before).toBe(0);

        // ensureReconcileAlarm scheduled at +24h, comfortably future.
        await runInDurableObject(stub, (instance, _state) => instance.alarm());

        // Reconcile did not run — D1 still stale.
        expect(await readD1Version(listId)).toBe(0);
    });

    it('legacy-fire fallback (no pending events) runs reconcile', async () => {
        // Simulates a pre-refactor DO: a Cloudflare alarm is set but
        // no `alarm:*:at` storage keys exist. Dispatcher's
        // empty-pending branch should treat the fire as reconcile so
        // ADR 0007 coverage is not lost at deploy time.
        const { listId, stub } = getListStub('disp3');
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_disp_3',
                clientID: 'c_disp_3',
                listId,
            }),
        });

        // Strip the reconcile event key so the dispatcher sees an
        // empty pending list — mirrors the pre-refactor state.
        await runInDurableObject(stub, (_i, state) =>
            state.storage.delete('alarm:reconcile:at'),
        );
        await env.DJIBB_AUTH.prepare(
            'UPDATE workspace_entities SET version = 0 WHERE id = ?',
        )
            .bind(listId)
            .run();

        await runInDurableObject(stub, (instance, _state) => instance.alarm());

        const { version: doVersion } = await readDoVersion(stub, listId);
        expect(await readD1Version(listId)).toBe(doVersion);

        // Reconcile re-scheduled itself, so the dispatcher is back
        // into normal state.
        const armed = await runInDurableObject(stub, (_i, state) =>
            state.storage.get<number>('alarm:reconcile:at'),
        );
        expect(armed).toBeGreaterThan(Date.now());
    });

    it('no-ops on a schemaless DO (post-hard-delete stray fire) instead of throwing', async () => {
        // Regression for the async path (c621d01). A real alarm fires
        // after the DO hard-deleted itself — `deleteAll()` dropped the
        // SQLite schema, so `list_elements` is gone. Without the
        // `isInitialized()` guard, the empty-pending legacy fire would
        // run reconcile and `getEntityId` (strict) would throw "no such
        // table". The guard clears the alarm slot and no-ops.
        const { listId, stub } = getListStub('schemaless');
        await stub.handlePush({
            authorizedAccounts: [],
            authorizedRole: 'ownerless',
            listId,
            pushRequest: makeInitListPush({
                clientGroupID: 'cg_schemaless',
                clientID: 'c_schemaless',
                listId,
            }),
        });

        // Simulate the post-hard-delete state: storage and the SQLite
        // schema wiped, but a stray Cloudflare alarm still in flight.
        await runInDurableObject(stub, async (_i, state) => {
            await state.storage.deleteAll();
            await state.storage.setAlarm(Date.now() - 1);
        });

        // Must resolve — a leaked reconcile would throw "no such table".
        await expect(
            runInDurableObject(stub, instance => instance.alarm()),
        ).resolves.toBeUndefined();

        // Guard cleared the alarm slot and left no events behind.
        const alarm = await runInDurableObject(stub, (_i, state) =>
            state.storage.getAlarm(),
        );
        expect(alarm).toBeNull();
    });
});
