// @ts-check

/**
 * Pure helpers for list-view single-row verbs (Slice B).
 *
 * Quantity math kept out of the .svelte.js shell so the workers
 * vitest pool can exercise it directly. Same cross-package pattern
 * as listViewSequence + undoStack.
 *
 * @typedef {{
 *   value: number,
 *   target_value: number,
 *   min_value?: number | null,
 *   max_value?: number | null,
 *   unit: string,
 * }} Quantity
 */

/**
 * "Toggle to extremes" — the Space-on-item behavior. Unit-agnostic.
 *
 *   value === target → drop to min (or 0 if min is missing)
 *   anything else    → jump to target
 *
 * For `bool` units this gives the obvious 0↔1 flip; for `count` units
 * (e.g. target=5) you get 0↔5; for stranger configs it always lands
 * on one of the two endpoints. No CAS check here — caller is expected
 * to pass the current `value` as `expected.quantity` so a race with
 * a peer is silently dropped.
 *
 * @param {Quantity} q
 * @returns {number}
 */
export function toggleQuantityValue(q) {
    const min = q.min_value ?? 0;
    if (q.value === q.target_value) return min;
    return q.target_value;
}

/**
 * D.3 — compute the row IDs to select for Cmd+A's first press.
 * Filters the flat-row sequence to rows matching the target type at
 * the target depth. Pure for ease of testing.
 *
 * @param {Array<{ id: string, type: 'item' | 'group', depth: number }>} rows
 * @param {'item' | 'group'} targetType
 * @param {number} targetDepth
 * @returns {string[]}
 */
export function computeSelectAtDepth(rows, targetType, targetDepth) {
    return rows
        .filter((r) => r.type === targetType && r.depth === targetDepth)
        .map((r) => r.id);
}

/**
 * D.3 — set-equality check for "is selection already saturated at
 * this depth?" Pure. Returns true iff sets are equal by membership.
 *
 * @param {Set<string>} selection
 * @param {string[]} ids
 * @returns {boolean}
 */
export function isSelectionEqualToSet(selection, ids) {
    if (selection.size !== ids.length) return false;
    for (const id of ids) {
        if (!selection.has(id)) return false;
    }
    return true;
}

/**
 * `+` / `-` step: change `value` by delta, clamped within min/max.
 *
 * Clamping rules:
 *   - min: q.min_value if present, else 0 (matches checkbox toggle
 *     behavior — value is always non-negative)
 *   - max: q.max_value if present, else Infinity (no ceiling)
 *
 * Returns the new value. Caller compares against `q.value` to detect
 * a no-op (e.g. trying to step below min). Pure — no I/O.
 *
 * @param {Quantity} q
 * @param {number} delta
 * @returns {number}
 */
export function stepQuantityValue(q, delta) {
    const min = q.min_value ?? 0;
    const max = q.max_value ?? Number.POSITIVE_INFINITY;
    const next = q.value + delta;
    if (next < min) return min;
    if (next > max) return max;
    return next;
}
