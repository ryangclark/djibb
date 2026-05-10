import { describe, it, expect } from 'vitest';

// D.1: pure mechanics for the list-view cursor. The reactive shell
// lives in listView.svelte.js — these helpers are what the shell
// delegates to. Tested here for the same reason as undoStack: pages
// has no vitest harness today and the workers pool can resolve the
// cross-package import.

import {
    buildFlatRows,
    collapsedStorageKey,
    loadCollapsed,
    nextCursorId,
    saveCollapsed,
} from '../../pages/src/lib/keymap/listViewSequence.js';

class MemoryStorage {
    private data = new Map<string, string>();
    getItem(k: string) {
        return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string) {
        this.data.set(k, v);
    }
}

describe('collapsedStorageKey', () => {
    it('mirrors the list ID into a stable namespaced key', () => {
        expect(collapsedStorageKey('l/abc')).toBe('djibb:list:l/abc:collapsed');
    });
});

describe('loadCollapsed', () => {
    it('returns an empty Set when storage is undefined (SSR-safe)', () => {
        expect(loadCollapsed('l/abc', undefined).size).toBe(0);
    });

    it('returns an empty Set when key is missing', () => {
        const storage = new MemoryStorage();
        expect(loadCollapsed('l/abc', storage).size).toBe(0);
    });

    it('round-trips a saved set', () => {
        const storage = new MemoryStorage();
        saveCollapsed('l/abc', new Set(['g/1', 'g/2']), storage);
        const loaded = loadCollapsed('l/abc', storage);
        expect(loaded.has('g/1')).toBe(true);
        expect(loaded.has('g/2')).toBe(true);
        expect(loaded.size).toBe(2);
    });

    it('survives malformed JSON', () => {
        const storage = new MemoryStorage();
        storage.setItem(collapsedStorageKey('l/abc'), 'not json{');
        expect(loadCollapsed('l/abc', storage).size).toBe(0);
    });

    it('rejects non-array payloads', () => {
        const storage = new MemoryStorage();
        storage.setItem(collapsedStorageKey('l/abc'), '{"oops": true}');
        expect(loadCollapsed('l/abc', storage).size).toBe(0);
    });

    it('filters non-string entries from a mixed array', () => {
        const storage = new MemoryStorage();
        storage.setItem(collapsedStorageKey('l/abc'), '["g/1", 42, null, "g/2"]');
        const loaded = loadCollapsed('l/abc', storage);
        expect([...loaded].sort()).toEqual(['g/1', 'g/2']);
    });

    it('scopes per-listId — sibling lists do not bleed', () => {
        const storage = new MemoryStorage();
        saveCollapsed('l/a', new Set(['g/x']), storage);
        saveCollapsed('l/b', new Set(['g/y']), storage);
        expect([...loadCollapsed('l/a', storage)]).toEqual(['g/x']);
        expect([...loadCollapsed('l/b', storage)]).toEqual(['g/y']);
    });
});

describe('saveCollapsed', () => {
    it('no-ops when storage is undefined', () => {
        expect(() => saveCollapsed('l/abc', new Set(['g/1']), undefined)).not.toThrow();
    });
});

// Test data shapes — minimal items / groups that exercise buildFlatRows
// without requiring the full Zod schema parsing.

function makeItem(id: string) {
    return { id, type: 'item' as const };
}
function makeGroup(id: string, children: string[]) {
    return { id, type: 'group' as const, child_element_refs: children };
}

describe('buildFlatRows', () => {
    it('returns an empty array for an empty list', () => {
        expect(buildFlatRows({ child_element_refs: [] }, {}, new Set())).toEqual([]);
    });

    it('flattens depth-0 items', () => {
        const list = { child_element_refs: ['i/1', 'i/2'] };
        const data = { 'i/1': makeItem('i/1'), 'i/2': makeItem('i/2') };
        const rows = buildFlatRows(list, data, new Set());
        expect(rows).toEqual([
            { id: 'i/1', type: 'item', depth: 0, parentGroupId: null },
            { id: 'i/2', type: 'item', depth: 0, parentGroupId: null },
        ]);
    });

    it('expanded group: group row at depth 0, children at depth 1 with parentGroupId set', () => {
        const list = { child_element_refs: ['g/1'] };
        const data = {
            'g/1': makeGroup('g/1', ['i/a', 'i/b']),
            'i/a': makeItem('i/a'),
            'i/b': makeItem('i/b'),
        };
        const rows = buildFlatRows(list, data, new Set());
        expect(rows).toEqual([
            { id: 'g/1', type: 'group', depth: 0, parentGroupId: null },
            { id: 'i/a', type: 'item', depth: 1, parentGroupId: 'g/1' },
            { id: 'i/b', type: 'item', depth: 1, parentGroupId: 'g/1' },
        ]);
    });

    it('collapsed group: group row appears, children skipped', () => {
        const list = { child_element_refs: ['g/1'] };
        const data = {
            'g/1': makeGroup('g/1', ['i/a', 'i/b']),
            'i/a': makeItem('i/a'),
            'i/b': makeItem('i/b'),
        };
        const rows = buildFlatRows(list, data, new Set(['g/1']));
        expect(rows).toEqual([
            { id: 'g/1', type: 'group', depth: 0, parentGroupId: null },
        ]);
    });

    it('skips dangling refs without throwing', () => {
        const list = { child_element_refs: ['i/missing', 'i/ok'] };
        const data = { 'i/ok': makeItem('i/ok') };
        const rows = buildFlatRows(list, data, new Set());
        expect(rows.map((r) => r.id)).toEqual(['i/ok']);
    });

    it('skips dangling group children without throwing', () => {
        const list = { child_element_refs: ['g/1'] };
        const data = {
            'g/1': makeGroup('g/1', ['i/missing', 'i/ok']),
            'i/ok': makeItem('i/ok'),
        };
        const rows = buildFlatRows(list, data, new Set());
        expect(rows.map((r) => r.id)).toEqual(['g/1', 'i/ok']);
    });

    it('mixed top-level: items and groups, ordering preserved', () => {
        const list = { child_element_refs: ['i/a', 'g/1', 'i/b'] };
        const data = {
            'i/a': makeItem('i/a'),
            'g/1': makeGroup('g/1', ['i/c']),
            'i/b': makeItem('i/b'),
            'i/c': makeItem('i/c'),
        };
        const rows = buildFlatRows(list, data, new Set());
        expect(rows.map((r) => r.id)).toEqual(['i/a', 'g/1', 'i/c', 'i/b']);
    });

    it('handles group with missing child_element_refs field', () => {
        const list = { child_element_refs: ['g/1'] };
        const data = { 'g/1': { id: 'g/1', type: 'group' as const } };
        const rows = buildFlatRows(list, data, new Set());
        expect(rows.map((r) => r.id)).toEqual(['g/1']);
    });

    it('handles list with missing child_element_refs field', () => {
        expect(buildFlatRows({}, {}, new Set())).toEqual([]);
    });
});

describe('nextCursorId', () => {
    const rows = [
        { id: 'a', type: 'item' as const, depth: 0, parentGroupId: null },
        { id: 'b', type: 'item' as const, depth: 0, parentGroupId: null },
        { id: 'c', type: 'item' as const, depth: 0, parentGroupId: null },
    ];

    it('null cursor + delta=+1 → first row', () => {
        expect(nextCursorId(rows, null, 1)).toBe('a');
    });

    it('null cursor + delta=-1 → last row', () => {
        expect(nextCursorId(rows, null, -1)).toBe('c');
    });

    it('empty rows + any cursor → null', () => {
        expect(nextCursorId([], 'a', 1)).toBeNull();
        expect(nextCursorId([], null, -1)).toBeNull();
    });

    it('mid-list + delta=+1 → next row', () => {
        expect(nextCursorId(rows, 'a', 1)).toBe('b');
        expect(nextCursorId(rows, 'b', 1)).toBe('c');
    });

    it('mid-list + delta=-1 → previous row', () => {
        expect(nextCursorId(rows, 'c', -1)).toBe('b');
        expect(nextCursorId(rows, 'b', -1)).toBe('a');
    });

    it('at bottom edge + delta=+1 → stays put (no wrap)', () => {
        expect(nextCursorId(rows, 'c', 1)).toBe('c');
    });

    it('at top edge + delta=-1 → stays put (no wrap)', () => {
        expect(nextCursorId(rows, 'a', -1)).toBe('a');
    });

    it('cursor not in rows (remote delete) → first row', () => {
        expect(nextCursorId(rows, 'gone', 1)).toBe('a');
    });
});
