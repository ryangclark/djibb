import { describe, it, expect } from 'vitest';

// D.7: keymap registry filtering + grouping. Pure helpers — the
// command palette filters this set, the cheatsheet groups it.

import {
    buildKeymapRegistry,
    filterPaletteBindings,
    groupByCategory,
} from '../../pages/src/lib/keymap/registry.js';

function noopDeps() {
    return {
        openCheatsheet: () => {},
        openPalette: () => {},
        closeOverlays: () => {},
        archiveList: () => {},
        navigateToShare: () => {},
        undo: () => {},
        redo: () => {},
    };
}

describe('buildKeymapRegistry', () => {
    it('produces a non-empty list of bindings', () => {
        const r = buildKeymapRegistry(noopDeps());
        expect(r.length).toBeGreaterThan(10);
    });

    it('includes the load-bearing palette actions', () => {
        const r = buildKeymapRegistry(noopDeps());
        const labels = r.map((b) => b.label);
        expect(labels).toContain('Archive list');
        expect(labels).toContain('Open command palette');
        expect(labels).toContain('Show keyboard cheatsheet');
        expect(labels).toContain('Undo last action');
        expect(labels).toContain('Redo last undone action');
    });

    it('Navigation bindings are informational (null action)', () => {
        const r = buildKeymapRegistry(noopDeps());
        const nav = r.filter((b) => b.category === 'Navigation');
        expect(nav.length).toBeGreaterThan(0);
        for (const b of nav) {
            expect(b.action).toBeNull();
        }
    });

    it('List-level bindings carry an action', () => {
        const r = buildKeymapRegistry(noopDeps());
        const list = r.filter((b) => b.category === 'List');
        expect(list.length).toBeGreaterThan(0);
        for (const b of list) {
            expect(typeof b.action).toBe('function');
        }
    });
});

describe('filterPaletteBindings', () => {
    const reg = buildKeymapRegistry(noopDeps());

    it('empty query → all actionable (action != null)', () => {
        const out = filterPaletteBindings(reg, '');
        expect(out.length).toBeGreaterThan(0);
        for (const b of out) {
            expect(b.action).not.toBeNull();
        }
    });

    it('skips informational entries even on empty query', () => {
        const out = filterPaletteBindings(reg, '');
        for (const b of out) {
            expect(b.category).not.toBe('Navigation');
        }
    });

    it('substring on label', () => {
        const out = filterPaletteBindings(reg, 'archive');
        expect(out.map((b) => b.label)).toContain('Archive list');
    });

    it('substring on category', () => {
        const out = filterPaletteBindings(reg, 'list');
        expect(out.length).toBeGreaterThan(0);
        // All matches are actionable
        for (const b of out) expect(b.action).not.toBeNull();
    });

    it('case-insensitive', () => {
        const lo = filterPaletteBindings(reg, 'archive');
        const up = filterPaletteBindings(reg, 'ARCHIVE');
        expect(up.map((b) => b.label)).toEqual(lo.map((b) => b.label));
    });

    it('no match → empty', () => {
        expect(filterPaletteBindings(reg, 'qwertyzzz')).toEqual([]);
    });

    it('whitespace-only query treated as empty', () => {
        const out = filterPaletteBindings(reg, '   ');
        expect(out.length).toBeGreaterThan(0);
    });
});

describe('groupByCategory', () => {
    const reg = buildKeymapRegistry(noopDeps());

    it('preserves registry order across categories', () => {
        const groups = groupByCategory(reg);
        const cats = groups.map(([c]) => c);
        // First category should match the first binding's category
        expect(cats[0]).toBe(reg[0].category);
    });

    it('every binding lands in exactly one group', () => {
        const groups = groupByCategory(reg);
        const total = groups.reduce((acc, [, items]) => acc + items.length, 0);
        expect(total).toBe(reg.length);
    });

    it('categories are unique', () => {
        const groups = groupByCategory(reg);
        const cats = groups.map(([c]) => c);
        expect(new Set(cats).size).toBe(cats.length);
    });
});
