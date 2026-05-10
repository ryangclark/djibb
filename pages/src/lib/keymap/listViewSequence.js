// @ts-check

/**
 * Pure helpers for the list-view cursor model. No Svelte runes here
 * so the workers' vitest pool can import this directly (pages has no
 * test harness yet). The reactive shell lives in `listView.svelte.js`.
 *
 * @typedef {{ id: string, type: 'item' | 'group', depth: number, parentGroupId: string | null }} FlatRow
 */

const COLLAPSED_KEY_PREFIX = 'djibb:list:';
const COLLAPSED_KEY_SUFFIX = ':collapsed';

/**
 * @param {string} listId
 * @returns {string}
 */
export function collapsedStorageKey(listId) {
    return `${COLLAPSED_KEY_PREFIX}${listId}${COLLAPSED_KEY_SUFFIX}`;
}

/**
 * Read collapsed-group IDs for a list from a storage-shaped object.
 * Defensive against malformed JSON or non-array payloads — returns
 * an empty Set. Storage param is injected for testability; callers
 * in browser pass `localStorage`.
 *
 * @param {string} listId
 * @param {Pick<Storage, 'getItem'> | undefined} storage
 * @returns {Set<string>}
 */
export function loadCollapsed(listId, storage) {
    if (!storage) return new Set();
    const raw = storage.getItem(collapsedStorageKey(listId));
    if (!raw) return new Set();
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((/** @type {unknown} */ x) => typeof x === 'string'));
    } catch {
        return new Set();
    }
}

/**
 * @param {string} listId
 * @param {Set<string>} collapsed
 * @param {Pick<Storage, 'setItem'> | undefined} storage
 */
export function saveCollapsed(listId, collapsed, storage) {
    if (!storage) return;
    storage.setItem(
        collapsedStorageKey(listId),
        JSON.stringify([...collapsed])
    );
}

/**
 * Build the flat, navigable row sequence from a list + its element
 * map + the collapsed-groups set. Collapsed groups appear as a row
 * themselves but their children are skipped.
 *
 * @param {{ child_element_refs?: string[] }} list
 * @param {Record<string, any>} data
 * @param {Set<string>} collapsed
 * @returns {FlatRow[]}
 */
export function buildFlatRows(list, data, collapsed) {
    /** @type {FlatRow[]} */
    const rows = [];
    for (const child_ref of list.child_element_refs ?? []) {
        const elem = data[child_ref];
        if (!elem) continue;
        if (elem.type === 'group') {
            rows.push({ id: child_ref, type: 'group', depth: 0, parentGroupId: null });
            if (!collapsed.has(child_ref)) {
                for (const grand of elem.child_element_refs ?? []) {
                    const grandElem = data[grand];
                    if (!grandElem) continue;
                    rows.push({
                        id: grand,
                        type: 'item',
                        depth: 1,
                        parentGroupId: child_ref
                    });
                }
            }
        } else if (elem.type === 'item') {
            rows.push({ id: child_ref, type: 'item', depth: 0, parentGroupId: null });
        }
    }
    return rows;
}

/**
 * Given the current cursor row + a direction, return the next row's
 * ID. Pure — exported so cursor-movement tests don't need to spin up
 * runes. Returns:
 *   - the new cursor ID
 *   - null if rows is empty (cursor must clear)
 *   - the same cursorId on an edge (no wrap)
 *
 * If cursor is null, j (delta=+1) lands on first row, k (delta=-1)
 * lands on last. This matches every list app's "first move" feel.
 *
 * @param {FlatRow[]} rows
 * @param {string | null} cursorId
 * @param {-1 | 1} delta
 * @returns {string | null}
 */
export function nextCursorId(rows, cursorId, delta) {
    if (rows.length === 0) return null;
    if (cursorId === null) {
        return delta > 0 ? rows[0].id : rows[rows.length - 1].id;
    }
    const idx = rows.findIndex((r) => r.id === cursorId);
    if (idx === -1) return rows[0].id;
    const next = idx + delta;
    if (next < 0 || next >= rows.length) return cursorId;
    return rows[next].id;
}
