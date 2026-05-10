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
 */

/** Maximum entries kept in the undo stack. ADR 0005. */
export const STACK_LIMIT = 50;

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
