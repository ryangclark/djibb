// @ts-check

/**
 * List-view cursor model — Slice A of ADR 0004's keyboard surface.
 *
 * The reactive shell. Pure mechanics (flat-row build, cursor next,
 * storage shape) live in `./listViewSequence.js` so workers/vitest
 * can exercise them without a Svelte preprocessor.
 *
 * Owns:
 *   - the cursor (an element ID, not an index — so remote inserts /
 *     deletes don't jitter under the user's hand)
 *   - the collapsed-groups set (localStorage-backed per list)
 *   - the flat row sequence derived from `list` + collapsed state
 *
 * Does NOT own:
 *   - mutations of any kind — D.1 is read-only navigation
 *   - selection — that's Slice B (`x`, Shift+arrow)
 *   - focus of the root element — the route component focuses it on
 *     mount; this module just consumes the focus
 */

import { untrack } from 'svelte';

import {
    buildFlatRows,
    loadCollapsed,
    nextCursorId,
    saveCollapsed
} from './listViewSequence.js';

/**
 * @param {object} input
 * @param {() => import('$djibb/list').List | import('$djibb/list').Template} input.getList
 *   Thunk so callers can pass a $derived value without unwrapping it
 *   at construction time.
 * @param {() => Record<string, any>} input.getData
 * @param {string} input.listId
 *   Stable list ID for storage scoping. The container's ID, not a row.
 */
export function createListViewCursor({ getList, getData, listId }) {
    const storage = typeof localStorage === 'undefined' ? undefined : localStorage;

    /** @type {string | null} */
    let cursorId = $state(null);

    let collapsed = $state(loadCollapsed(listId, storage));

    let rows = $derived.by(() => buildFlatRows(getList(), getData(), collapsed));

    // Cursor clamp: if a remote mutation removed the row under the
    // cursor, fall to the first surviving row. Untracked so we don't
    // accidentally re-read cursorId reactively from inside its own
    // setter.
    $effect(() => {
        const current = cursorId;
        const list = rows;
        if (current === null) return;
        if (list.some((r) => r.id === current)) return;
        untrack(() => {
            cursorId = list[0]?.id ?? null;
        });
    });

    // Persist collapsed-set changes.
    $effect(() => {
        saveCollapsed(listId, new Set(collapsed), storage);
    });

    /** @param {-1 | 1} delta */
    function moveBy(delta) {
        cursorId = nextCursorId(rows, cursorId, delta);
    }

    function moveHome() {
        cursorId = rows[0]?.id ?? null;
    }

    function moveEnd() {
        const list = rows;
        cursorId = list[list.length - 1]?.id ?? null;
    }

    /**
     * `h` / `←` — collapse / parent.
     *   - on expanded group: collapse it
     *   - on collapsed group: stay (the caret already shows state)
     *   - on item inside group: jump to parent group
     *   - on item at depth 0: no-op
     */
    function collapseOrParent() {
        const id = cursorId;
        if (!id) return;
        const row = rows.find((r) => r.id === id);
        if (!row) return;
        if (row.type === 'group') {
            if (!collapsed.has(id)) {
                collapsed = new Set([...collapsed, id]);
            }
            return;
        }
        if (row.parentGroupId) {
            cursorId = row.parentGroupId;
        }
    }

    /**
     * `l` / `→` — expand / descend.
     *   - on collapsed group: expand it
     *   - on expanded group with children: jump to first child
     *   - on expanded empty group: no-op
     *   - on item: no-op (future slices may treat `l` on a
     *     reference-bearing item as "open ref")
     */
    function expandOrDescend() {
        const id = cursorId;
        if (!id) return;
        const row = rows.find((r) => r.id === id);
        if (!row) return;
        if (row.type !== 'group') return;
        if (collapsed.has(id)) {
            const next = new Set(collapsed);
            next.delete(id);
            collapsed = next;
            return;
        }
        const groupElem = getData()[id];
        const firstChild = groupElem?.child_element_refs?.[0];
        if (firstChild) {
            cursorId = firstChild;
        }
    }

    /**
     * Esc cascade (D.1 stub): only the "blur list" leg exists yet.
     * Future slices short-circuit when a panel / selection is open.
     */
    function escape() {
        cursorId = null;
        const root = document.activeElement;
        if (root instanceof HTMLElement) root.blur();
    }

    /**
     * @param {KeyboardEvent} event
     */
    function handleKeydown(event) {
        const t = event.target;
        // Editable surfaces own their keys (inline create, name edit,
        // picker search). ADR 0004 §"Conventions".
        if (
            t instanceof HTMLInputElement ||
            t instanceof HTMLTextAreaElement ||
            (t instanceof HTMLElement && t.isContentEditable)
        ) {
            return;
        }

        // Modifier-prefixed gestures belong to the global keymap or
        // later slices. Bail so we don't swallow Cmd+Z / Cmd+K / etc.
        if (event.metaKey || event.ctrlKey || event.altKey) return;

        switch (event.key) {
            case 'j':
            case 'ArrowDown':
                event.preventDefault();
                moveBy(1);
                return;
            case 'k':
            case 'ArrowUp':
                event.preventDefault();
                moveBy(-1);
                return;
            case 'h':
            case 'ArrowLeft':
                event.preventDefault();
                collapseOrParent();
                return;
            case 'l':
            case 'ArrowRight':
                event.preventDefault();
                expandOrDescend();
                return;
            case 'Home':
                event.preventDefault();
                moveHome();
                return;
            case 'End':
                event.preventDefault();
                moveEnd();
                return;
            case 'Escape':
                event.preventDefault();
                escape();
                return;
        }
    }

    return {
        get cursorId() {
            return cursorId;
        },
        get rows() {
            return rows;
        },
        /** @param {string} groupId */
        isCollapsed(groupId) {
            return collapsed.has(groupId);
        },
        /** @param {string} id */
        isCursor(id) {
            return cursorId === id;
        },
        /**
         * Imperative cursor move — used by row-click handlers so
         * clicking a row makes it the cursor row.
         *
         * @param {string} id
         */
        setCursor(id) {
            cursorId = id;
        },
        handleKeydown
    };
}
