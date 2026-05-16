// @ts-check

/**
 * Pure (non-Svelte) stack mechanics for the undo runtime per ADR
 * 0005. The Svelte shell at `withUndo.svelte.js` wraps these in
 * `$state` so reactivity works; this module is the bookkeeping the
 * shell delegates to.
 *
 * Design tenet: every method takes the stacks as input and returns
 * the new stacks. No internal state; trivially testable without a
 * Svelte runtime.
 */

/**
 * @typedef {object} Entry
 * @property {string} forwardName
 * @property {Record<string, unknown>} forwardArgs
 * @property {string} inverseName
 * @property {Record<string, unknown>} inverseArgs
 * @property {number} timestamp
 * @property {number} [mutationID]
 *   Replicache mutationID of the forward, captured at push time.
 *   Lets the outcome channel prune this entry when the server
 *   reports `auth`/`stale`/`gone` for the same mutationID — i.e.
 *   the forward never landed, so there's nothing to inverse.
 *   Optional because pendingMutations capture is best-effort
 *   (race: a mutation can push+ack before we read pending).
 */

/** Maximum entries kept in the undo stack. ADR 0005. */
export const STACK_LIMIT = 50;

/**
 * Reorder-mutator coalescing. ADR 0005 §"Reorder coalescing": when
 * the user drags an item through several intermediate positions
 * within the 500ms window, those collapse to one undo entry whose
 * preState is the position before the **first** move.
 *
 * Merge rule (reorder-specific, since this is the only coalescing
 * shape today):
 *   - forward     ← latest mutation's forward (current position)
 *   - inverse.toIndex      ← original's inverse.toIndex (where we
 *                            were before the first move)
 *   - inverse.expected     ← {fromIndex: latest forward's toIndex}
 *                            (CAS guard against the current state)
 *   - timestamp   ← latest, so the window rolls with continued
 *                   activity
 *
 * @param {Entry} top
 * @param {Entry} entry
 * @returns {Entry}
 */
export function coalesceReorderEntry(top, entry) {
    const latestToIndex = /** @type {number} */ (
        /** @type {any} */ (entry.forwardArgs).toIndex
    );
    return {
        forwardName: entry.forwardName,
        forwardArgs: entry.forwardArgs,
        inverseName: top.inverseName,
        inverseArgs: {
            .../** @type {any} */ (top.inverseArgs),
            expected: { fromIndex: latestToIndex },
        },
        timestamp: entry.timestamp,
    };
}

/**
 * Try to coalesce `entry` into the top of `stack`. Returns the new
 * (replacement) entry when coalescing applies, or `null` to push the
 * incoming entry normally. Caller owns the array surgery.
 *
 * @param {Entry[]} stack
 * @param {Entry} entry
 * @param {readonly string[]} coalescingMutators
 * @param {number} windowMs
 * @returns {Entry | null}
 */
export function tryCoalesce(stack, entry, coalescingMutators, windowMs) {
    const top = stack[stack.length - 1];
    if (!top) return null;
    if (!coalescingMutators.includes(entry.forwardName)) return null;
    if (top.forwardName !== entry.forwardName) return null;
    const topId = /** @type {any} */ (top.forwardArgs).id;
    const entryId = /** @type {any} */ (entry.forwardArgs).id;
    if (topId !== entryId) return null;
    if (entry.timestamp - top.timestamp > windowMs) return null;
    return coalesceReorderEntry(top, entry);
}

/**
 * Storage-key helper. Per-account, per-list isolation; sessionStorage
 * (per-tab) for per-tab undo history (Cmd+R survives, new-tab does
 * not). ADR 0005 §"Personal/per-list/per-tab."
 *
 * @param {string | null | undefined} accountId
 * @param {string} listId
 */
export function stackStorageKey(accountId, listId) {
    return `djibb:undo:${accountId ?? 'anon'}:${listId}`;
}

/**
 * Push an entry. Truncates from the front if over `limit`. Returns a
 * new array — the caller updates whatever holds the stack.
 *
 * @param {Entry[]} stack
 * @param {Entry} entry
 * @param {number} [limit]
 * @returns {Entry[]}
 */
export function pushWithLimit(stack, entry, limit = STACK_LIMIT) {
    const next = [...stack, entry];
    if (next.length > limit) {
        return next.slice(next.length - limit);
    }
    return next;
}

/**
 * Remove every entry whose forward was rejected. Used by the outcome
 * channel: when the server reports `auth`/`stale`/`gone` for a
 * mutationID, the matching entry (if any) is dropped because its
 * forward never took effect — inversing it would clobber unrelated
 * state. Returns `[nextStack, removedCount]`.
 *
 * @param {Entry[]} stack
 * @param {number} mutationID
 * @returns {[Entry[], number]}
 */
export function pruneByMutationID(stack, mutationID) {
    const next = stack.filter((e) => e.mutationID !== mutationID);
    return [next, stack.length - next.length];
}

/**
 * Pop the last entry. Returns `[remainingStack, popped|undefined]`.
 *
 * @param {Entry[]} stack
 * @returns {[Entry[], Entry | undefined]}
 */
export function popLast(stack) {
    if (stack.length === 0) return [stack, undefined];
    return [stack.slice(0, -1), stack[stack.length - 1]];
}

/**
 * sessionStorage load with strict shape validation. Bad data
 * (corrupted JSON, wrong types) returns []; the runtime's stack
 * starts empty rather than throwing on a poisoned tab.
 *
 * @param {Storage | undefined} storage
 * @param {string} key
 * @returns {Entry[]}
 */
export function loadStack(storage, key) {
    if (!storage) return [];
    try {
        const raw = storage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        // Trust shape on read — we wrote it ourselves. Parse failures
        // here would mean tampering or version skew; either way, [] is
        // the safe fallback.
        return parsed;
    } catch {
        return [];
    }
}

/**
 * @param {Storage | undefined} storage
 * @param {string} key
 * @param {Entry[]} stack
 */
export function saveStack(storage, key, stack) {
    if (!storage) return;
    try {
        storage.setItem(key, JSON.stringify(stack));
    } catch {
        // Quota / disabled storage — silent skip. Worst case, undo
        // history doesn't survive a Cmd+R.
    }
}
