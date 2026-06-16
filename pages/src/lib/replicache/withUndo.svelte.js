// @ts-check
import {
    COALESCE_WINDOW_MS,
    COALESCING_MUTATORS,
    FRICTION_TIER_MUTATORS,
    Mutations
} from '@djibb/protocol/list/mutators/client';
import {
    loadStack,
    popLast,
    pruneByMutationID,
    pushWithLimit,
    saveStack,
    stackStorageKey,
    tryCoalesce
} from '@djibb/client/undoStack';

/**
 * Per-tab, per-(account, list) undo runtime per ADR 0005.
 *
 * Wraps the envelope-injected `mutate` proxy with a second layer that:
 *   1. Captures pre-state via the per-mutator `capturePreState` export
 *      BEFORE firing the forward (set-family only).
 *   2. Computes the inverse via the per-mutator `inverse` export.
 *   3. Pushes a stack entry containing the inverse (already armed
 *      with `expected`/CAS for defensive undo per ADR 0005).
 *
 * Two firing paths reach the same envelope-injection wrapper:
 *
 *   `mutate.foo(args)`         — system path: no stack entry. Used by
 *                                app code that does its own
 *                                lifecycle accounting (e.g. initList
 *                                fired automatically on first load).
 *   `mutateWithUndo.foo(args)` — user path: pushes an undo entry.
 *                                Used wherever a UI gesture
 *                                originates the action.
 *
 * `undo()` and `redo()` reach the same envelope wrapper via the
 * system path; they don't recurse through this layer.
 *
 * Pure stack mechanics (push limit, load/save, key shape) live in
 * `./undoStack.js` — that module is testable without a Svelte
 * harness. This file is the reactive shell.
 *
 * Friction tier (ADR 0005): mutators in `FRICTION_TIER_MUTATORS`
 * (auth-rules + list-creation, structural threshold) prompt a
 * confirm-toast on undo. The runtime calls `onConfirm` if wired and
 * only fires the inverse if it resolves true; if no `onConfirm` is
 * wired, friction silently passes (the inverse fires anyway). C.2
 * wires the confirm UI.
 */

/**
 * @typedef {import('@djibb/client/undoStack').Entry} Entry
 *
 * Toast events the runtime emits, all through one `onToast` callback
 * with a discriminated `kind`. The receiver (C.1's UndoToast) renders
 * different surfaces per kind:
 *
 *   'action' — a user mutation just landed on the stack; show "Undid
 *              X — Cmd+Z to undo" with an Undo CTA.
 *   'auth' | 'stale' | 'gone' | 'precondition' — the server rejected
 *              the mutation; show the failure reason. Per-mutation
 *              outcome from ADR 0006 (extended by ADR 0009 Slice 3).
 *              Optional `reason` is the structured per-mutator failure
 *              code (e.g. `rate_limit_hour`); optional `message` is
 *              the human-readable phrasing the server attached. The
 *              UI prefers `message` when present and falls back to
 *              its own generic copy otherwise. No Undo CTA — the
 *              mutation didn't apply.
 *
 * Most-recent-wins collapse is the UI's job; the runtime fires
 * regardless of pacing.
 *
 * @typedef {{kind: 'action'} & {entry: Entry}} ActionToastEvent
 * @typedef {{
 *   kind: 'auth' | 'stale' | 'gone' | 'precondition',
 *   mutationID: number,
 *   reason?: string,
 *   message?: string
 * }} OutcomeToastEvent
 * @typedef {ActionToastEvent | OutcomeToastEvent} ToastEvent
 *
 * @typedef {object} CreateInput
 * @property {import('replicache').Replicache} client
 * @property {Record<string, (args: any) => any>} mutate
 * @property {string | null} accountId
 * @property {string} listId
 * @property {(name: string) => Promise<boolean>} [onConfirm]
 * @property {(event: ToastEvent) => void} [onToast]
 */

/**
 * @param {CreateInput} input
 */
export function createUndoRuntime({ client, mutate, accountId, listId, onConfirm, onToast }) {
    const key = stackStorageKey(accountId, listId);
    const storage = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;

    let stack = $state(loadStack(storage, key));
    /** @type {Entry[]} */
    let redoStack = $state([]);

    /** @param {Entry[]} next */
    function commitStack(next) {
        stack = next;
        saveStack(storage, key, next);
    }

    /**
     * The user firing path. Mirrors `mutate`'s shape (Proxy keyed by
     * mutator wire name) but adds capture-then-fire-then-push. Typed as
     * the named `ClientListMutators` surface so call sites can reach
     * individual mutators (`mutateWithUndo.setItemFields(...)`).
     *
     * @type {import('./types').ClientListMutators}
     */
    const mutateWithUndo = new Proxy(/** @type {any} */ ({}), {
        get(_, name) {
            if (typeof name !== 'string') return undefined;

            // @ts-expect-error — Mutations is a typed registry but the
            // string-keyed proxy access is intentionally loose here.
            const moduleEntry = Mutations[name];
            if (!moduleEntry) {
                console.warn(`[withUndo] unknown mutator "${name}"`);
                return undefined;
            }

            return async (/** @type {Record<string, unknown>} */ body) => {
                /** @type {Record<string, unknown> | undefined} */
                let preState = undefined;
                if (moduleEntry.capturePreState) {
                    try {
                        preState = await client.query(
                            (/** @type {import('replicache').ReadTransaction} */ tx) =>
                                moduleEntry.capturePreState(tx, body)
                        );
                    } catch (err) {
                        console.warn(
                            `[withUndo] capturePreState for "${name}" threw:`,
                            err
                        );
                    }
                }

                // Snapshot pending mutationIDs before the call so we
                // can identify the new one after. Per-client IDs are
                // monotonic, so any id we see post-await that wasn't
                // in `beforeIds` belongs to a mutation queued during
                // (or by) this call.
                /** @type {Set<number>} */
                let beforeIds = new Set();
                try {
                    const before = await client.experimentalPendingMutations();
                    beforeIds = new Set(before.map((p) => p.id));
                } catch (err) {
                    console.warn(`[withUndo] pendingMutations pre-snapshot threw:`, err);
                }

                const result = await mutate[name](body);

                // Find our mutationID. Best-effort: if a fast
                // push+ack already removed it from pending, we
                // proceed without an ID and lose the prune-on-failure
                // affordance for this entry only.
                /** @type {number | undefined} */
                let mutationID = undefined;
                try {
                    const after = await client.experimentalPendingMutations();
                    for (const p of after) {
                        if (beforeIds.has(p.id)) continue;
                        if (p.name !== name) continue;
                        // Highest matching new id wins — concurrent
                        // mutates of the same name resolve in queue
                        // order, so the most recent one belongs to
                        // the just-awaited call.
                        if (mutationID === undefined || p.id > mutationID) {
                            mutationID = p.id;
                        }
                    }
                } catch (err) {
                    console.warn(`[withUndo] pendingMutations post-snapshot threw:`, err);
                }

                if (moduleEntry.inverse) {
                    const inv = moduleEntry.inverse(body, preState);
                    if (inv) {
                        const newEntry = {
                            forwardName: name,
                            forwardArgs: body,
                            inverseName: inv.name,
                            inverseArgs: /** @type {Record<string, unknown>} */ (
                                inv.args
                            ),
                            timestamp: Date.now(),
                            mutationID
                        };
                        // Reorder coalescing: same target within 500ms
                        // replaces the top entry rather than stacking
                        // (ADR 0005 §"Reorder coalescing").
                        const merged = tryCoalesce(
                            stack,
                            newEntry,
                            COALESCING_MUTATORS,
                            COALESCE_WINDOW_MS
                        );
                        /** @type {Entry} */
                        let pushedEntry;
                        if (merged) {
                            pushedEntry = merged;
                            commitStack([...stack.slice(0, -1), merged]);
                        } else {
                            pushedEntry = newEntry;
                            commitStack(pushWithLimit(stack, newEntry));
                        }
                        // Any new user action invalidates redo history.
                        redoStack = [];

                        // Fire the action toast — UI shows "Undo" CTA.
                        // Coalesced entries fire as a fresh toast too;
                        // most-recent-wins collapse is the UI's job.
                        onToast?.({ kind: 'action', entry: pushedEntry });
                    }
                }

                return result;
            };
        }
    });

    /**
     * Pop the top entry and fire its inverse via the system path.
     * Friction-tier mutators prompt via `onConfirm` first.
     *
     * @returns {Promise<boolean>} false when there's nothing to undo
     *   or the user declined the friction prompt.
     */
    async function undo() {
        const entry = stack[stack.length - 1];
        if (!entry) return false;

        if (FRICTION_TIER_MUTATORS.includes(entry.forwardName)) {
            const ok = onConfirm ? await onConfirm(entry.forwardName) : true;
            if (!ok) return false;
        }

        await mutate[entry.inverseName](entry.inverseArgs);

        const [next, popped] = popLast(stack);
        commitStack(next);
        if (popped) redoStack = [...redoStack, popped];
        return true;
    }

    /**
     * Pop the top redo entry and re-fire its forward via the system
     * path.
     *
     * @returns {Promise<boolean>} false when the redo stack is empty.
     */
    async function redo() {
        const entry = redoStack[redoStack.length - 1];
        if (!entry) return false;

        await mutate[entry.forwardName](entry.forwardArgs);

        const [next, popped] = popLast(redoStack);
        redoStack = next;
        if (popped) commitStack([...stack, popped]);
        return true;
    }

    /**
     * Reset stacks. Account switch / list-route change.
     */
    function clear() {
        commitStack([]);
        redoStack = [];
    }

    /**
     * Outcome-channel sink. The page route calls this for every
     * `mutation_outcome` WS frame; the runtime maps the wire shape
     * to a discriminated toast event for the UI.
     *
     * Pruning: when the server rejects a mutation
     * (`auth`/`stale`/`gone`), the forward never landed, so any
     * undo/redo entry tagged with that mutationID is invalid —
     * inversing would clobber unrelated state. Drop it from
     * whichever stack it lives on before emitting the toast.
     *
     * @param {{
     *   status: 'auth' | 'stale' | 'gone' | 'precondition',
     *   mutationID: number,
     *   reason?: string,
     *   message?: string,
     * }} event
     */
    function handleOutcome(event) {
        const [prunedStack, undoRemoved] = pruneByMutationID(stack, event.mutationID);
        if (undoRemoved > 0) commitStack(prunedStack);

        const [prunedRedo, redoRemoved] = pruneByMutationID(redoStack, event.mutationID);
        if (redoRemoved > 0) redoStack = prunedRedo;

        onToast?.({
            kind: event.status,
            mutationID: event.mutationID,
            ...(event.reason !== undefined && { reason: event.reason }),
            ...(event.message !== undefined && { message: event.message }),
        });
    }

    return {
        mutate,
        mutateWithUndo,
        undo,
        redo,
        clear,
        handleOutcome,
        get canUndo() {
            return stack.length > 0;
        },
        get canRedo() {
            return redoStack.length > 0;
        },
        get stack() {
            return stack;
        },
        get redoStack() {
            return redoStack;
        }
    };
}
