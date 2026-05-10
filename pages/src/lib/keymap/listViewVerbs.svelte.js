// @ts-check

/**
 * List-view single-row verbs — Slice B of ADR 0004.
 *
 * Composes `createListViewCursor` and adds:
 *   - the verb keys that fire mutations against the cursor row
 *     (Cmd+Backspace, Space, +, -)
 *   - the selection set (x, Shift+arrow), homogeneous by row type
 *
 * D.2 does NOT yet route verbs through the selection — that's D.3.
 * Here, Cmd+Backspace / Space / +/- always act on the cursor row;
 * `x` and Shift+arrow only build the selection. The selection
 * highlight renders but doesn't change verb routing yet.
 *
 * Design seam: cursor module owns navigation, this module owns
 * "doing things." That keeps the pure-mechanic tests in cursor's
 * orbit clean, and lets the route bind one handler that dispatches
 * verbs first, falling through to cursor.handleKeydown when no
 * verb matched. Same skip-rules discipline as cursor: bail inside
 * editable surfaces; verbs that need a modifier check explicitly.
 */

import { createListViewCursor } from './listView.svelte.js';
import { stepQuantityValue, toggleQuantityValue } from './listViewVerbsLogic.js';

/**
 * @param {object} input
 * @param {() => import('$djibb/list').List | import('$djibb/list').Template} input.getList
 * @param {() => Record<string, any>} input.getData
 * @param {string} input.listId
 * @param {import('$lib/replicache/types').ClientListMutators & { archiveListItem: any, archiveListGroup: any, setItemQuantity: any }} input.mutateWithUndo
 *   The undo-stack-pushing mutator surface from
 *   `replicacheList.undoRuntime.mutateWithUndo`. User-firing path.
 */
export function createListViewVerbs({ getList, getData, listId, mutateWithUndo }) {
    const cursor = createListViewCursor({ getList, getData, listId });

    /** @type {'item' | 'group' | null} */
    let selectionType = $state(null);

    /** @type {Set<string>} */
    let selection = $state(new Set());

    /**
     * Toggle a row in the selection. Type-homogeneity rule (ADR 0004):
     * a selection is either all-items or all-groups. Mismatched type
     * replaces the selection wholesale.
     *
     * @param {string} id
     * @param {'item' | 'group'} type
     */
    function toggleSelection(id, type) {
        if (selectionType === null || selectionType !== type) {
            selectionType = type;
            selection = new Set([id]);
            return;
        }
        const next = new Set(selection);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        if (next.size === 0) {
            selectionType = null;
        }
        selection = next;
    }

    /**
     * Shift+Arrow extend. Standard list-app feel:
     *   1. Seed selection with current cursor row (if any)
     *   2. Move cursor by delta
     *   3. Add new cursor row to selection (or replace if type
     *      mismatch with current selectionType)
     *
     * Returns true if it did anything — caller can decide whether to
     * preventDefault. We always handle the event since the caller is
     * already inside a Shift+Arrow branch.
     *
     * @param {-1 | 1} delta
     */
    function extendSelection(delta) {
        const current = cursor.cursorId;
        const rows = cursor.rows;
        if (rows.length === 0) return;

        // Seed with current cursor row if present
        if (current) {
            const row = rows.find((r) => r.id === current);
            if (row) toggleSelectionEnsure(row.id, row.type);
        }

        // Move cursor by delta
        const idx = current ? rows.findIndex((r) => r.id === current) : -1;
        const nextIdx = idx === -1 ? (delta > 0 ? 0 : rows.length - 1) : idx + delta;
        if (nextIdx < 0 || nextIdx >= rows.length) return;
        const nextRow = rows[nextIdx];
        cursor.setCursor(nextRow.id);

        // Add new cursor row to selection
        toggleSelectionEnsure(nextRow.id, nextRow.type);
    }

    /**
     * Like toggleSelection but only ADDS — used by Shift+arrow which
     * is an extend, never a shrink (we leave shrink to `x`).
     *
     * @param {string} id
     * @param {'item' | 'group'} type
     */
    function toggleSelectionEnsure(id, type) {
        if (selectionType === null || selectionType !== type) {
            selectionType = type;
            selection = new Set([id]);
            return;
        }
        if (selection.has(id)) return;
        const next = new Set(selection);
        next.add(id);
        selection = next;
    }

    function clearSelection() {
        selection = new Set();
        selectionType = null;
    }

    /**
     * Look up the element under the cursor. Returns null if the cursor
     * is unset or the row's element isn't in `data` (transient mid-pull).
     */
    function cursorElement() {
        const id = cursor.cursorId;
        if (!id) return null;
        return getData()[id] ?? null;
    }

    async function archiveCursor() {
        const elem = cursorElement();
        if (!elem) return;
        if (elem.type === 'item') {
            await mutateWithUndo.archiveListItem({ id: elem.id });
        } else if (elem.type === 'group') {
            await mutateWithUndo.archiveListGroup({ id: elem.id });
        }
    }

    /**
     * Space on item → flip value between min/target.
     * Space on group → toggle collapse (same as `l` toggle).
     */
    async function toggleCursorSpace() {
        const elem = cursorElement();
        if (!elem) return;
        if (elem.type === 'group') {
            // Reach into cursor's expand/descend via a synthetic key?
            // Cleaner: expose collapse toggle on cursor. For now we
            // mimic l's expand-if-collapsed and h's collapse-if-not.
            const collapsed = cursor.isCollapsed(elem.id);
            cursor.setCursor(elem.id);
            // Fire one of the existing key paths through the handler.
            // Synthesizing here is cheaper than threading a new API.
            const evt = new KeyboardEvent('keydown', {
                key: collapsed ? 'l' : 'h'
            });
            cursor.handleKeydown(evt);
            return;
        }
        if (elem.type === 'item') {
            const nextValue = toggleQuantityValue(elem.value);
            await mutateWithUndo.setItemQuantity({
                itemId: elem.id,
                quantity: { ...elem.value, value: nextValue },
                expected: { quantity: elem.value }
            });
        }
    }

    /** @param {-1 | 1} delta */
    async function stepCursor(delta) {
        const elem = cursorElement();
        if (!elem || elem.type !== 'item') return;
        const nextValue = stepQuantityValue(elem.value, delta);
        if (nextValue === elem.value.value) return; // clamp no-op
        await mutateWithUndo.setItemQuantity({
            itemId: elem.id,
            quantity: { ...elem.value, value: nextValue },
            expected: { quantity: elem.value }
        });
    }

    /**
     * Toggle the cursor row in selection. Bound to `x`.
     */
    function toggleCursorInSelection() {
        const elem = cursorElement();
        if (!elem) return;
        if (elem.type !== 'item' && elem.type !== 'group') return;
        toggleSelection(elem.id, elem.type);
    }

    /**
     * @param {KeyboardEvent} event
     */
    function handleKeydown(event) {
        const t = event.target;
        if (
            t instanceof HTMLInputElement ||
            t instanceof HTMLTextAreaElement ||
            (t instanceof HTMLElement && t.isContentEditable)
        ) {
            return;
        }

        const mod = event.metaKey || event.ctrlKey;

        // Cmd/Ctrl+Backspace — archive cursor row. Item: no confirm
        // (undo is the safety net). Group: no confirm — undo also
        // restores the group + its children atomically.
        if (mod && event.key === 'Backspace') {
            event.preventDefault();
            void archiveCursor();
            return;
        }

        // Shift+Arrow — extend selection. Must come before the
        // single-key Space/+/− block so Shift+Arrow doesn't fall
        // through to plain Arrow.
        if (event.shiftKey && !mod && event.key === 'ArrowDown') {
            event.preventDefault();
            extendSelection(1);
            return;
        }
        if (event.shiftKey && !mod && event.key === 'ArrowUp') {
            event.preventDefault();
            extendSelection(-1);
            return;
        }

        // From here on, no modifiers — single-key verbs.
        if (mod || event.altKey || event.shiftKey) {
            cursor.handleKeydown(event);
            return;
        }

        switch (event.key) {
            case ' ': // Space
                event.preventDefault();
                void toggleCursorSpace();
                return;
            case '+':
            case '=': // `+` without holding shift on US layouts
                event.preventDefault();
                void stepCursor(1);
                return;
            case '-':
                event.preventDefault();
                void stepCursor(-1);
                return;
            case 'x':
                event.preventDefault();
                toggleCursorInSelection();
                return;
            case 'Escape':
                // Esc cascade (D.1+): if selection is non-empty, clear
                // it first; else fall through to cursor's blur.
                if (selection.size > 0) {
                    event.preventDefault();
                    clearSelection();
                    return;
                }
                cursor.handleKeydown(event);
                return;
        }

        cursor.handleKeydown(event);
    }

    return {
        // re-expose cursor API
        get cursorId() {
            return cursor.cursorId;
        },
        get rows() {
            return cursor.rows;
        },
        /** @param {string} id */
        isCollapsed(id) {
            return cursor.isCollapsed(id);
        },
        /** @param {string} id */
        isCursor(id) {
            return cursor.isCursor(id);
        },
        /** @param {string} id */
        setCursor(id) {
            cursor.setCursor(id);
        },
        // selection API
        get selection() {
            return selection;
        },
        get selectionType() {
            return selectionType;
        },
        /** @param {string} id */
        isSelected(id) {
            return selection.has(id);
        },
        clearSelection,
        handleKeydown
    };
}
