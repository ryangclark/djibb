/**
 * Workspace cascade module (ADR 0026 series 1). The cascade dispatcher's
 * *logic*, carved out of the `DjibbList` DO into `sql.ts`-idiom free
 * functions with narrow, explicit dependencies (no `this`, no
 * `{ctx,env}`). The DO keeps thin delegating method shells so the
 * existing external DO tests — which drive `handleCascadeArchive()` /
 * `handleHardDelete()` / `alarm()` via `runInDurableObject` — are the
 * unchanged regression signal.
 *
 * The alarm *dispatcher* (`alarm`/`runAlarmEvent`/`scheduleEvent`/
 * `cancelEvent`/`rearmAlarm`/`ensureReconcileAlarm`/`handleReconcile`)
 * stays on the DO; the cascade *handlers* here receive the scheduler as
 * an injected `AlarmScheduler` interface so tests can drive them with a
 * fake in-memory scheduler.
 */
import type { AlarmEventName } from '../list/alarm-events';
import { getEntityId } from '../list/sql';
import {
    DeleteEntityRow,
    ListCascadeArchiveBatch,
    ListCascadeRestoreBatch,
} from '../derived-index/d1';
import type { DjibbList } from '../list/durable_object';

/**
 * A narrow view of the DO's multi-event alarm scheduler. The DO
 * satisfies it with (schedule = scheduleEvent, cancel = cancelEvent);
 * tests pass a fake in-memory scheduler to assert re-arm behavior.
 */
export interface AlarmScheduler {
    schedule(name: AlarmEventName, dueAtMs: number): Promise<void>;
    cancel(name: AlarmEventName): Promise<void>;
}

export interface CascadeDeps {
    sql: SqlStorage;
    d1: D1Database; // env.DJIBB_AUTH
    listNs: DurableObjectNamespace; // env.DJIBB_LIST (sibling-child push)
    scheduler: AlarmScheduler;
    batchSize: number; // DjibbList.CASCADE_ARCHIVE_BATCH_SIZE
}

export interface HardDeleteDeps {
    sql: SqlStorage;
    d1: D1Database;
    scheduler: AlarmScheduler;
    deleteAllStorage: () => Promise<void>; // ctx.storage.deleteAll()
    retryBackoffMs?: number; // defaults to 60_000, matching current code
}

// ---------------------------------------------------------------------------
// Push-path triggers + post-commit workspace tail (ADR 0026 series 1,
// slice 2). The DO's `_handlePush` mutation loop calls the pure predicates
// per mutation to raise the flags; after the commit it hands the folded
// flags to `applyWorkspacePostCommit`, which schedules/cancels the alarm
// events and mints the replacement personal workspace. Keeping the tail
// here (not in the DO) puts the whole cascade lifecycle — detection +
// scheduling + handlers — behind one module seam.
// ---------------------------------------------------------------------------

// The push-path trigger predicates live in the leaf `./triggers` module so
// `list/postCommit.ts` (a pure fold, tested in plain node) can use them
// without transitively importing this module's D1/Effect graph. Re-exported
// here so existing importers of `workspace/cascade` are unaffected.
export {
    harddeleteTransition,
    isCascadeArchiveTrigger,
    isCascadeRestoreTrigger,
} from './triggers';

export interface WorkspacePostCommitDeps {
    scheduler: AlarmScheduler;
    hardDeleteDelayMs: number; // DjibbList.HARD_DELETE_DELAY_MS
    // Mint the actor's replacement personal workspace after a
    // `startFresh` archived the old one. Injected (not called directly)
    // so the DO owns the DJIBB_LIST binding + Account shaping and tests
    // can pass a spy.
    mintPersonalWorkspace: (actor: {
        accountId: string;
        displayName: string | null;
    }) => Promise<void>;
}

export interface WorkspacePostCommitFlags {
    // Raised by `isCascadeArchiveTrigger` in the mutation loop.
    cascadeArchiveTriggered: boolean;
    // Raised by `isCascadeRestoreTrigger`.
    cascadeRestoreTriggered: boolean;
    // Last `harddeleteTransition` result across the push (last write
    // wins), or null if no mutation transitioned the soft-delete state.
    harddelete: 'arm' | 'clear' | null;
    // Actor + display name captured from a `startFresh` mutation, or null.
    startFresh: { accountId: string; displayName: string | null } | null;
    // This DO's entity id, for log context only.
    listId: string;
}

/**
 * Post-commit workspace tail (ADR 0008, ADR 0011 §Step 10a/10b/10c).
 * Runs after the push's mutations have all committed and the entity
 * snapshot has been emitted. Folds the four independent, log-and-swallow
 * blocks the DO used to inline:
 *
 *   1. cascade-archive trigger → cancel any pending cascade-restore
 *      (mid-sweep flip), schedule cascade-archive for immediate fire.
 *   2. cascade-restore trigger → cancel cascade-archive, schedule
 *      cascade-restore.
 *   3. startFresh → mint the actor's replacement personal workspace.
 *   4. hard-delete clock arm/clear.
 *
 * Each block swallows its own failure: the entity is already committed,
 * and a scheduling blip should not fail the user's push. The alarm
 * handlers' own safety nets (re-reading `time_deleted`) cover a missed
 * clear.
 */
export async function applyWorkspacePostCommit(
    deps: WorkspacePostCommitDeps,
    flags: WorkspacePostCommitFlags
): Promise<void> {
    const { scheduler, hardDeleteDelayMs, mintPersonalWorkspace } = deps;
    const { listId } = flags;

    // ADR 0008 §"Trigger": enqueue the cascade-archive event for
    // immediate fire. Scheduled AFTER `emitEntitySnapshot` (by the caller)
    // so the workspace's own `time_deleted` is already in the catalog
    // before any child begins its sweep. Also cancels any pending
    // cascade-restore so a mid-sweep flip doesn't leave the dispatcher
    // chasing the older direction.
    if (flags.cascadeArchiveTriggered) {
        try {
            await scheduler.cancel('cascade-restore');
            await scheduler.schedule('cascade-archive', Date.now());
        } catch (error) {
            console.error(
                `\`scheduleEvent('cascade-archive')\` failed for "${listId}":`,
                error
            );
        }
    }

    // ADR 0008 §"Restore": symmetric to the archive trigger. Cancels any
    // pending cascade-archive (mid-sweep flip) and enqueues cascade-
    // restore for immediate fire.
    if (flags.cascadeRestoreTriggered) {
        try {
            await scheduler.cancel('cascade-archive');
            await scheduler.schedule('cascade-restore', Date.now());
        } catch (error) {
            console.error(
                `\`scheduleEvent('cascade-restore')\` failed for "${listId}":`,
                error
            );
        }
    }

    // ADR 0008 §"Personal Workspace: 'Start Fresh,' not Delete" / ADR 0011
    // §Step 10c: mint a fresh personal workspace for the actor immediately
    // after their old one got archived by `startFresh`. Failures are
    // logged-but-swallowed — the cascade-archive and harddelete clock on
    // the old workspace are already scheduled above; if the mint fails,
    // the user lands in a weird zero-personal-workspaces state until the
    // next signin.
    if (flags.startFresh) {
        try {
            await mintPersonalWorkspace(flags.startFresh);
        } catch (error) {
            console.error(
                `\`startFresh\` mint failed for actor "${flags.startFresh.accountId}":`,
                error
            );
        }
    }

    // ADR 0008 hard-delete clock (10b). Armed when this push soft-deleted
    // the DO's own entity row; cleared when restored. 30d from now
    // (override via `HARD_DELETE_DELAY_MS` for tests). The handler's
    // safety net (re-reads `time_deleted` before destroying anything)
    // means a missed `clear` won't hard-delete a restored entity — but we
    // still clear here so the alarm doesn't fire pointlessly 30d later.
    if (flags.harddelete === 'arm') {
        try {
            await scheduler.schedule(
                'harddelete',
                Date.now() + hardDeleteDelayMs
            );
        } catch (error) {
            console.error(
                `\`scheduleEvent('harddelete')\` failed for "${listId}":`,
                error
            );
        }
    } else if (flags.harddelete === 'clear') {
        try {
            await scheduler.cancel('harddelete');
        } catch (error) {
            console.error(
                `\`cancelEvent('harddelete')\` failed for "${listId}":`,
                error
            );
        }
    }
}

/**
 * Workspace cascade-archive sweep (ADR 0008, ADR 0011 §Step 10a.4b).
 *
 * Runs only on workspace-typed DOs: the trigger in `_handlePush` only
 * enqueues this event when an `archiveList` against a workspace-prefix
 * id commits. Reads this workspace's child entities from the D1 catalog
 * (`workspace_entities WHERE workspace_id = self AND time_deleted IS
 * NULL AND cascade_source IS NULL`) in batches of N and dispatches a
 * `cascadeArchiveList` push to each child's DO via synthetic-client RPC
 * (`cascade:<workspaceId>:<deletionTsMs>` clientID per ADR 0008).
 *
 * Self-progressing without an explicit cursor: each successful cascade-
 * archive sets the child's `time_deleted` and `cascade_source`, removing
 * it from the next batch's SELECT. A failed cascade leaves the child
 * visible to the next tick, which re-tries on the next alarm — at-least-
 * once delivery.
 *
 * State-driven mid-sweep restore (ADR 0008 §"Restore"): if the
 * workspace's own `time_deleted` is null when this fires (a
 * `restoreWorkspace` raced in between the user's Delete and this tick),
 * the sweep aborts.
 *
 * Re-arms itself for "immediate" (`Date.now()`) when a batch was
 * non-empty, so subsequent ticks continue draining. Cancels the event
 * when the catalog query returns empty — the campaign is either complete
 * or the workspace was restored.
 */
export async function cascadeArchiveSweep(deps: CascadeDeps): Promise<void> {
    const { sql, d1, listNs, scheduler, batchSize } = deps;
    const entityId = getEntityId(sql);
    if (!entityId || !entityId.startsWith('w/')) {
        // Not a workspace DO. Should never reach the handler given the
        // trigger guard in `_handlePush`, but a misconfigured event key
        // shouldn't loop forever.
        console.warn(
            `\`cascadeArchiveSweep()\` not a workspace entity (id="${entityId}"); canceling`
        );
        await scheduler.cancel('cascade-archive');
        return;
    }

    // Read this workspace's own time_deleted to use as the deletion-
    // timestamp portion of the synthetic clientID. Also doubles as the
    // abort check: if the user restored the workspace before this tick,
    // time_deleted is null and we bail.
    const own = sql
        .exec(`SELECT time_deleted FROM list_elements WHERE id = ?;`, entityId)
        .one();
    const ownTimeDeletedRaw = own?.time_deleted as number | null;
    if (ownTimeDeletedRaw == null) {
        console.log(
            `\`cascadeArchiveSweep()\` workspace "${entityId}" not deleted; canceling`
        );
        await scheduler.cancel('cascade-archive');
        return;
    }
    // time_deleted is unix seconds in the DO row (`getElementById`
    // multiplies by 1000); raw column read is seconds. Convert to ms for
    // the clientID — keeps the cascade campaign id stable across restarts
    // even though the wall clock has moved.
    const deletionTsMs = ownTimeDeletedRaw * 1000;

    const rows = await ListCascadeArchiveBatch(d1, entityId, batchSize);
    if (rows.length === 0) {
        // Drained. Per ADR 0008 the next workspace-side event is the 30d
        // hard-delete clock (10b); we don't set it here because the
        // trigger landed it at archive time. Just clear the cascade-
        // archive key.
        await scheduler.cancel('cascade-archive');
        return;
    }

    for (const childId of rows) {
        try {
            await cascadeArchiveChild(
                listNs,
                childId,
                entityId,
                deletionTsMs
            );
        } catch (error) {
            console.error(
                `\`cascadeArchiveSweep()\` child push failed for "${childId}":`,
                error
            );
            // Leave the child unarchived; next batch re-selects it (its
            // time_deleted didn't get set). Retries are bounded by
            // progress on the rest of the batch.
        }
    }

    // Re-arm for "immediate" — the dispatcher will run us again when
    // Cloudflare's alarm fires next. A batch < N children doesn't mean
    // we're done (a write could have raced); keep looping until the
    // SELECT comes back empty.
    await scheduler.schedule('cascade-archive', Date.now());
}

/**
 * Cascade-archive a single child entity (List or Template) via a
 * synthetic-client push to its DO. ADR 0008 §"Cascade-archive
 * invocation":
 *
 *   - clientID = `cascade:<workspaceId>:<deletionTimestampMs>` —
 *     campaign-scoped; a fresh deletion mints a fresh clientID, so
 *     delete→restore→delete cycles never reuse one.
 *   - mutationId = 1 — child DOs each maintain their own
 *     `replicache_clients` table, so this clientID is new to every child
 *     the first time we push to it; mutationId=1 works uniformly across
 *     all children of one campaign. Retries on the same child are
 *     idempotent: Replicache recognizes mutationId=1 as already-processed
 *     and no-ops.
 *   - authorizedRole = 'system' — gates on the cascade mutator's
 *     SYSTEM_ROLES requiredRole (ADR 0011 §Step 10a.3).
 */
export async function cascadeArchiveChild(
    listNs: DurableObjectNamespace,
    childId: string,
    workspaceId: string,
    deletionTsMs: number
): Promise<void> {
    const stubId = listNs.idFromName(childId);
    const stub = listNs.get(stubId) as unknown as DurableObjectStub<DjibbList>;
    const clientID = `cascade:${workspaceId}:${deletionTsMs}`;

    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'system',
        listId: childId,
        pushRequest: {
            profileID: 'p_cascade',
            clientGroupID: `cg_cascade:${workspaceId}`,
            pushVersion: 1,
            schemaVersion: '1',
            mutations: [
                {
                    clientID,
                    id: 1,
                    name: 'cascadeArchiveList',
                    timestamp: Date.now(),
                    args: {
                        accountId: null,
                        timestamp_client: new Date().toISOString(),
                        listId: childId,
                        cascade_source: workspaceId,
                    },
                },
            ],
        },
    });
}

/**
 * Workspace cascade-restore sweep (ADR 0008, ADR 0011 §Step 10a.5).
 *
 * Mirror of `cascadeArchiveSweep`. Drains children whose `cascade_source`
 * matches this workspace's id and whose `time_deleted` is still set —
 * i.e. the ones this specific deletion-then-restore campaign needs to
 * flip back.
 *
 * Skip semantics (preserved from the archive side, by SQL design):
 *
 *   - `cascade_source IS NULL` (user-archived before the workspace was
 *     deleted) → excluded from the batch. The user's prior intent —
 *     "this list belongs in the trash" — survives the workspace round-
 *     trip.
 *   - `cascade_source != self` (cascaded under a different workspace) →
 *     excluded. Each workspace restores only what it archived.
 *   - `time_deleted IS NULL` (already restored or never archived) →
 *     excluded. Idempotent against partial-restore retries.
 *
 * Mid-restore re-archive: reads the workspace's own `time_deleted` first.
 * If non-null (a fresh `archiveList` raced ahead of this tick), the sweep
 * cancels; the `_handlePush` trigger has already re-enqueued cascade-
 * archive for the resumption.
 *
 * Cursorless, like the archive side: each successful restore clears the
 * child's `cascade_source`, dropping it from the next batch's SELECT.
 * Re-arms on any non-empty batch; cancels on empty.
 */
export async function cascadeRestoreSweep(deps: CascadeDeps): Promise<void> {
    const { sql, d1, listNs, scheduler, batchSize } = deps;
    const entityId = getEntityId(sql);
    if (!entityId || !entityId.startsWith('w/')) {
        console.warn(
            `\`cascadeRestoreSweep()\` not a workspace entity (id="${entityId}"); canceling`
        );
        await scheduler.cancel('cascade-restore');
        return;
    }

    const own = sql
        .exec(
            `SELECT time_deleted, time_updated FROM list_elements WHERE id = ?;`,
            entityId
        )
        .one();
    const ownTimeDeleted = own?.time_deleted as number | null;
    if (ownTimeDeleted != null) {
        // Workspace got re-archived between the user's restore and this
        // alarm tick. The archive trigger has already enqueued cascade-
        // archive; cancel restore to avoid chasing the older direction.
        console.log(
            `\`cascadeRestoreSweep()\` workspace "${entityId}" re-archived; canceling restore`
        );
        await scheduler.cancel('cascade-restore');
        return;
    }
    // The workspace's `time_updated` was bumped by the unarchiveList that
    // triggered this sweep, so it's a monotonic per-campaign timestamp —
    // same epoch role the deletion timestamp plays for cascade-archive.
    // Without it, a delete→restore→delete→restore cycle would re-use the
    // same clientID across the two restore campaigns; Replicache's
    // per-(DO, clientID) mutationID counter would then skip the second
    // restore's push as already-processed.
    const restoreTsMs = (own.time_updated as number) * 1000;

    const rows = await ListCascadeRestoreBatch(d1, entityId, batchSize);
    if (rows.length === 0) {
        await scheduler.cancel('cascade-restore');
        return;
    }

    for (const childId of rows) {
        try {
            await cascadeRestoreChild(
                listNs,
                childId,
                entityId,
                restoreTsMs
            );
        } catch (error) {
            console.error(
                `\`cascadeRestoreSweep()\` child push failed for "${childId}":`,
                error
            );
        }
    }

    await scheduler.schedule('cascade-restore', Date.now());
}

/**
 * Cascade-restore a single child entity via synthetic-client push.
 * Symmetric with `cascadeArchiveChild`: clientID encodes the campaign
 * epoch (here, the workspace's `time_updated` from when the unarchive
 * ran), so delete→restore→delete→restore cycles never reuse a clientID.
 * Without this, the second restore's mutationId=1 push would be rejected
 * by Replicache as already-processed against the first restore's
 * clientID, and the second restore would silently no-op.
 */
export async function cascadeRestoreChild(
    listNs: DurableObjectNamespace,
    childId: string,
    workspaceId: string,
    restoreTsMs: number
): Promise<void> {
    const stubId = listNs.idFromName(childId);
    const stub = listNs.get(stubId) as unknown as DurableObjectStub<DjibbList>;
    const clientID = `cascade-restore:${workspaceId}:${restoreTsMs}`;

    await stub.handlePush({
        authorizedAccounts: [],
        authorizedRole: 'system',
        listId: childId,
        pushRequest: {
            profileID: 'p_cascade',
            clientGroupID: `cg_cascade:${workspaceId}`,
            pushVersion: 1,
            schemaVersion: '1',
            mutations: [
                {
                    clientID,
                    id: 1,
                    name: 'cascadeRestoreList',
                    timestamp: Date.now(),
                    args: {
                        accountId: null,
                        timestamp_client: new Date().toISOString(),
                        listId: childId,
                        cascade_source: workspaceId,
                    },
                },
            ],
        },
    });
}

/**
 * Hard-delete sweep (ADR 0008 §"Hard-delete: per-DO self-destruct via the
 * alarm dispatcher", ADR 0011 §Step 10b-clock). Fires 30d after the
 * entity was soft-deleted. Self-destructs the DO:
 *
 *   1. Re-read the entity's `time_deleted`. If null, the entity was
 *      restored between the unarchive's `cancelEvent('harddelete')` write
 *      and this alarm tick — safety net, cancel and return. (`cancel` is
 *      idempotent against a missing key; we still call it explicitly to
 *      clean up the `alarm:harddelete:at` storage row this fire
 *      originated from, which Cloudflare's alarm dispatch does not
 *      auto-clear.)
 *   2. Purge the D1 catalog row (`workspace_entities` per ADR 0003). This
 *      is the read index every list/picker/Trash UI consults; once gone,
 *      the entity stops appearing anywhere.
 *   3. `deleteAllStorage()` (ctx.storage.deleteAll()) — wipes the DO's
 *      SQLite + KV storage including the alarm-event keys and the
 *      Cloudflare alarm itself. No further re-scheduling.
 *
 * If the D1 delete fails, we re-arm at a short backoff rather than call
 * `deleteAllStorage`. A vanished DO with a live catalog row would be
 * worse than a soft-deleted entity sitting in limbo a little longer.
 *
 * Workspace vs. child entity: same handler. The 10a cascade-archive sweep
 * arms each child's own `harddelete` clock (because `cascadeArchiveList`
 * runs through the same _handlePush trigger path as `archiveList`), so
 * every cascaded child self-destructs 30d after the workspace was
 * deleted, independently of the workspace's own self-destruct. The
 * workspace DO's own clock fires at the same time (give or take async
 * drift in the cascade fan-out), so the whole tree drains together.
 *
 * Returns `true` if the DO self-destructed (terminal), signaling the
 * alarm dispatcher to stop dispatching further due events.
 */
export async function hardDeleteSweep(deps: HardDeleteDeps): Promise<boolean> {
    const { sql, d1, scheduler, deleteAllStorage } = deps;
    const retryBackoffMs = deps.retryBackoffMs ?? 60 * 1000;
    const entityId = getEntityId(sql);
    if (!entityId) {
        // No entity row in this DO — either never initialized, or already
        // hard-deleted by a prior tick. Defensive cancel so a stuck
        // alarm-event key doesn't loop.
        console.warn('`hardDeleteSweep()` no entity row; canceling');
        await scheduler.cancel('harddelete');
        return false;
    }

    const own = sql
        .exec(`SELECT time_deleted FROM list_elements WHERE id = ?;`, entityId)
        .one();
    const ownTimeDeleted = own?.time_deleted as number | null;
    if (ownTimeDeleted == null) {
        // Restored mid-flight. The unarchive's `cancelEvent` should have
        // dropped this event from storage, but races happen — the safety
        // net catches them. Cancel and return.
        console.log(
            `\`hardDeleteSweep()\` entity "${entityId}" not deleted; canceling`
        );
        await scheduler.cancel('harddelete');
        return false;
    }

    // Purge the catalog row first. If this fails the DO survives — a
    // vanished DO with a live catalog row is worse than the current limbo
    // state.
    try {
        await DeleteEntityRow(d1, entityId);
    } catch (error) {
        console.error(
            `\`hardDeleteSweep()\` D1 purge failed for "${entityId}":`,
            error
        );
        // Re-arm at a short backoff so the next tick retries the purge.
        // The entity is still soft-deleted, so the safety net stays valid
        // against an intervening restore.
        await scheduler.schedule('harddelete', Date.now() + retryBackoffMs);
        return false;
    }

    // DO storage gone. Per ADR 0008: no further alarm scheduling.
    // `deleteAll()` removes the SQLite + KV state (including the
    // `alarm:*:at` event keys) and clears the Cloudflare alarm. After
    // this call the DO has nothing left to do; subsequent pushes (if any
    // stale ones arrive) hit an uninitialized DO and either fail or
    // re-bootstrap empty — both safe.
    await deleteAllStorage();

    // Terminal: signal the alarm dispatcher to stop. The `pending` map it
    // was iterating was read before this `deleteAll()`, so any remaining
    // due events (e.g. a co-scheduled `reconcile`) would otherwise run
    // against a now-destroyed DO — querying a dropped `list_elements`
    // table (harmless log noise) and, worse, re-arming themselves,
    // resurrecting storage we just wiped.
    return true;
}
