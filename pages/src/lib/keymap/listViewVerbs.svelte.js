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
import {
    computeSelectAtDepth,
    isSelectionEqualToSet,
    stepQuantityValue,
    toggleQuantityValue
} from './listViewVerbsLogic.js';

/**
 * @param {object} input
 * @param {() => import('$djibb/list').List | import('$djibb/list').Template} input.getList
 * @param {() => Record<string, any>} input.getData
 * @param {() => string} input.getListId
 *   Thunk for the active list id (same reactivity reason as
 *   `getList` / `getData`).
 * @param {() => import('$lib/replicache/types').ClientListMutators & { archiveListItem: any, archiveListGroup: any, setItemQuantity: any }} input.getMutateWithUndo
 *   Thunk for the undo-stack-pushing mutator surface. Must be a
 *   thunk because in Svelte 5, prop bindings (like `mutateWithUndo`
 *   in the consuming component) lose reactivity when passed directly
 *   to a function — they capture the value at construction time
 *   (state_referenced_locally). Same pattern as `getList` / `getData`.
 * @param {() => void} [input.onOpenEditPanel]
 *   D.4: called when Enter fires on the cursor row. The component
 *   owns the panel state — the verbs module only signals intent.
 * @param {() => void} [input.onOpenInlineCreate]
 *   D.4: called when `n` fires. Component shows the inline create row
 *   and focuses the input.
 * @param {() => void} [input.onOpenCheatsheet]
 *   D.7: called when `?` fires. Route/component owns the overlay state.
 */
export function createListViewVerbs({
    getList,
    getData,
    getListId,
    getMutateWithUndo,
    onOpenEditPanel,
    onOpenInlineCreate,
    onOpenCheatsheet
}) {
    const cursor = createListViewCursor({ getList, getData, getListId });

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
            await getMutateWithUndo().archiveListItem({ id: elem.id });
        } else if (elem.type === 'group') {
            await getMutateWithUndo().archiveListGroup({ id: elem.id });
        }
    }

    /**
     * D.3 — bulk archive. Splits the selection by type and fires the
     * bulk mutators. In practice the selection is homogeneous (we
     * enforce that in toggleSelection), so one of these is always a
     * zero-length call — we still send both for safety in case a
     * type-bypass slips in.
     */
    async function bulkArchive() {
        if (selection.size === 0) return;
        const ids = [...selection];
        const data = getData();
        const itemIds = ids.filter((id) => data[id]?.type === 'item');
        const groupIds = ids.filter((id) => data[id]?.type === 'group');
        clearSelection();
        if (itemIds.length > 0) {
            await getMutateWithUndo().archiveListItems({ ids: itemIds });
        }
        if (groupIds.length > 0) {
            await getMutateWithUndo().archiveListGroups({ ids: groupIds });
        }
    }

    /**
     * D.3 — bulk Space. Spec: "each row to its own target_value".
     * Unit-agnostic. Per-entry expected = current quantity so a
     * concurrent peer edit drops just that entry (atomic per ADR 0005:
     * the umbrella mutator is all-or-nothing per envelope, but a CAS
     * miss on any one drops the whole batch — that's intentional, the
     * UI's mental model is "this snapshot of the selection").
     */
    async function bulkSpace() {
        if (selection.size === 0) return;
        const data = getData();
        const items = [...selection]
            .map((id) => data[id])
            .filter((e) => e && e.type === 'item');
        if (items.length === 0) return;
        const entries = items.map((item) => ({
            id: item.id,
            fields: {
                value: { ...item.value, value: item.value.target_value }
            },
            expected: { value: item.value }
        }));
        await getMutateWithUndo().setItemsAtomic({ items: entries });
    }

    /**
     * D.3 — Cmd+A. First press: select all rows of the cursor's type
     * at the cursor's depth. Second press (selection already matches
     * that target): expand to all rows of the cursor's type, any depth.
     *
     * If no cursor, default to all top-level items.
     */
    function selectAtDepth() {
        const rows = cursor.rows;
        const data = getData();
        const cursorId = cursor.cursorId;
        const cursorRow = cursorId ? rows.find((r) => r.id === cursorId) : null;
        // Default type when no cursor: 'item'.
        const targetType = cursorRow?.type ?? 'item';
        const targetDepth = cursorRow?.depth ?? 0;

        const sameDepth = computeSelectAtDepth(rows, targetType, targetDepth);
        const alreadySaturated = isSelectionEqualToSet(selection, sameDepth);

        const next = alreadySaturated
            ? new Set(rows.filter((r) => r.type === targetType).map((r) => r.id))
            : new Set(sameDepth);

        // Cross-check homogeneity (computeSelectAtDepth already filters
        // by targetType, but be explicit).
        selectionType = targetType;
        selection = next;
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
            await getMutateWithUndo().setItemQuantity({
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
        await getMutateWithUndo().setItemQuantity({
            itemId: elem.id,
            quantity: { ...elem.value, value: nextValue },
            expected: { quantity: elem.value }
        });
    }

    /**
     * D.6 — Cmd+↑ / Cmd+↓ reorder. Moves the cursor row up or down
     * within its parent's child_element_refs.
     *
     * Parent resolution:
     *   - depth-0 row: parent is the list itself (list.id)
     *   - depth-1 row: parent is the row's group (row.parentGroupId)
     *
     * Coalescing (500ms same-target merge) lives inside withUndo so
     * the undo stack collapses a rapid Cmd+↓ Cmd+↓ Cmd+↓ run into
     * one entry. No work needed here — we just fire the mutator.
     *
     * @param {-1 | 1} delta
     */
    async function reorderCursor(delta) {
        const cursorId = cursor.cursorId;
        if (!cursorId) return;
        const row = cursor.rows.find((r) => r.id === cursorId);
        if (!row) return;
        const list = getList();
        const data = getData();
        const parentId = row.parentGroupId ?? list.id;
        const parent = parentId === list.id ? list : data[parentId];
        const refs = parent?.child_element_refs ?? [];
        const fromIndex = refs.indexOf(cursorId);
        if (fromIndex === -1) return;
        const toIndex = fromIndex + delta;
        if (toIndex < 0 || toIndex >= refs.length) return; // edge clamp
        const mutatorName =
            row.type === 'group' ? 'reorderListGroup' : 'reorderListItem';
        await getMutateWithUndo()[mutatorName]({
            id: cursorId,
            toIndex,
            expected: { fromIndex }
        });
    }

    /**
     * D.5 — Shift+Space on a group: bulk-check every item child to
     * its own target_value. No-op if the cursor isn't on a group or
     * the group has no item children (e.g. all children are groups).
     * Uses setItemsAtomic so the whole batch shares one envelope and
     * undo is one stack entry.
     */
    async function checkAllInGroup() {
        const elem = cursorElement();
        if (!elem || elem.type !== 'group') return;
        const data = getData();
        const refs = elem.child_element_refs ?? [];
        const items = refs
            .map((/** @type {string} */ id) => data[id])
            .filter((/** @type {any} */ e) => e && e.type === 'item');
        if (items.length === 0) return;
        const entries = items.map((/** @type {any} */ item) => ({
            id: item.id,
            fields: {
                value: { ...item.value, value: item.value.target_value }
            },
            expected: { value: item.value }
        }));
        await getMutateWithUndo().setItemsAtomic({ items: entries });
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

        // Cmd/Ctrl+Backspace — archive. D.3 routing: if selection is
        // non-empty, fire the bulk mutators; else archive the cursor
        // row. Undo restores either.
        if (mod && event.key === 'Backspace') {
            event.preventDefault();
            if (selection.size > 0) {
                void bulkArchive();
            } else {
                void archiveCursor();
            }
            return;
        }

        // Cmd/Ctrl+A — select-at-depth (D.3). Hijacks the browser's
        // native select-all on the page; cheap because nothing else
        // here is selectable text in our model.
        if (mod && !event.shiftKey && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            selectAtDepth();
            return;
        }

        // D.6 — Cmd+ArrowUp / Cmd+ArrowDown reorder within parent.
        if (mod && !event.shiftKey && event.key === 'ArrowUp') {
            event.preventDefault();
            void reorderCursor(-1);
            return;
        }
        if (mod && !event.shiftKey && event.key === 'ArrowDown') {
            event.preventDefault();
            void reorderCursor(1);
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

        // D.5 — Shift+Space on group: check all items in group. The
        // bulk Space (D.3 selection) takes precedence if a selection
        // is open; otherwise we route by cursor's row type.
        if (event.shiftKey && !mod && event.key === ' ') {
            event.preventDefault();
            void checkAllInGroup();
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
                if (selection.size > 0) {
                    void bulkSpace();
                } else {
                    void toggleCursorSpace();
                }
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
            case 'Enter':
                // D.4: open edit panel for the cursor row. If no
                // cursor, no-op (panel needs a target). Component
                // gates on cursorId itself; we just signal intent.
                if (cursor.cursorId && onOpenEditPanel) {
                    event.preventDefault();
                    onOpenEditPanel();
                }
                return;
            case 'n':
                // D.4: inline-create. Component shows the input row.
                if (onOpenInlineCreate) {
                    event.preventDefault();
                    onOpenInlineCreate();
                }
                return;
            case '?':
                // D.7: cheatsheet overlay. Single-key bind so only fires
                // when list container is focused — outside an input the
                // `?` key is otherwise meaningless in our model.
                if (onOpenCheatsheet) {
                    event.preventDefault();
                    onOpenCheatsheet();
                }
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
