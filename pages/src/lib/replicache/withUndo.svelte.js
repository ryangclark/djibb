// @ts-check
import { Mutations, FRICTION_TIER_MUTATORS } from '$djibb/list/mutators/client';
import {
    loadStack,
    popLast,
    pushWithLimit,
    saveStack,
    stackStorageKey
} from './undoStack.js';

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
 * @typedef {import('./undoStack.js').Entry} Entry
 *
 * @typedef {object} ToastEvent
 * @property {'auth' | 'stale' | 'gone'} status
 * @property {number} mutationID
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
     * mutator wire name) but adds capture-then-fire-then-push.
     *
     * @type {Record<string, (args: any) => Promise<unknown>>}
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

                const result = await mutate[name](body);

                if (moduleEntry.inverse) {
                    const inv = moduleEntry.inverse(body, preState);
                    if (inv) {
                        commitStack(
                            pushWithLimit(stack, {
                                forwardName: name,
                                forwardArgs: body,
                                inverseName: inv.name,
                                inverseArgs: /** @type {Record<string, unknown>} */ (
                                    inv.args
                                ),
                                timestamp: Date.now()
                            })
                        );
                        // Any new user action invalidates redo history.
                        redoStack = [];
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
     * Outcome-channel sink. Today: pure toast dispatch. ADR 0005's
     * follow-on cleanup (prune entries whose forward `auth`/`gone`'d
     * server-side) is a B.2.x TODO — requires associating Replicache
     * mutationIDs with stack entries.
     *
     * @param {ToastEvent} event
     */
    function handleOutcome(event) {
        // TODO(B.2.x): tag stack entries with the Replicache mutationID
        // they emit so we can prune on auth/gone outcomes.
        onToast?.(event);
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
