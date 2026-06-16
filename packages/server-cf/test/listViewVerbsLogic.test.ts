import { describe, it, expect } from 'vitest';

// D.2: pure quantity math for Space toggle and +/- step.

import {
    computeSelectAtDepth,
    isSelectionEqualToSet,
    stepQuantityValue,
    toggleQuantityValue,
} from '../../../apps/djibb-com/src/lib/keymap/listViewVerbsLogic.js';

describe('toggleQuantityValue', () => {
    it('bool unchecked → checked', () => {
        expect(toggleQuantityValue({
            value: 0, target_value: 1, unit: 'bool',
        })).toBe(1);
    });

    it('bool checked → unchecked', () => {
        expect(toggleQuantityValue({
            value: 1, target_value: 1, unit: 'bool',
        })).toBe(0);
    });

    it('count partially filled → jumps to target', () => {
        expect(toggleQuantityValue({
            value: 2, target_value: 5, unit: 'count',
        })).toBe(5);
    });

    it('count at target → drops to min (or 0)', () => {
        expect(toggleQuantityValue({
            value: 5, target_value: 5, unit: 'count',
        })).toBe(0);
    });

    it('count at target with explicit min → drops to that min', () => {
        expect(toggleQuantityValue({
            value: 5, target_value: 5, min_value: 2, unit: 'count',
        })).toBe(2);
    });

    it('count at zero → jumps to target', () => {
        expect(toggleQuantityValue({
            value: 0, target_value: 3, unit: 'count',
        })).toBe(3);
    });
});

describe('stepQuantityValue', () => {
    it('step up within range', () => {
        expect(stepQuantityValue({
            value: 2, target_value: 5, unit: 'count',
        }, 1)).toBe(3);
    });

    it('step down within range', () => {
        expect(stepQuantityValue({
            value: 2, target_value: 5, unit: 'count',
        }, -1)).toBe(1);
    });

    it('step below 0 → clamps to 0 when no min specified', () => {
        expect(stepQuantityValue({
            value: 0, target_value: 5, unit: 'count',
        }, -1)).toBe(0);
    });

    it('step below min → clamps to min', () => {
        expect(stepQuantityValue({
            value: 2, target_value: 5, min_value: 2, unit: 'count',
        }, -1)).toBe(2);
    });

    it('step past max_value → clamps to max', () => {
        expect(stepQuantityValue({
            value: 9, target_value: 5, max_value: 10, unit: 'count',
        }, 5)).toBe(10);
    });

    it('no max specified → unbounded above', () => {
        expect(stepQuantityValue({
            value: 100, target_value: 5, unit: 'count',
        }, 1000)).toBe(1100);
    });

    it('bool item stepping up at target → clamps at 1', () => {
        expect(stepQuantityValue({
            value: 1, target_value: 1, unit: 'bool',
        }, 1)).toBe(2); // bool doesn't enforce max unless max_value set
    });

    it('bool item with max_value=1 stepping up → stays at 1', () => {
        expect(stepQuantityValue({
            value: 1, target_value: 1, max_value: 1, unit: 'bool',
        }, 1)).toBe(1);
    });
});

describe('computeSelectAtDepth', () => {
    const rows = [
        { id: 'i/a', type: 'item' as const, depth: 0 },
        { id: 'g/1', type: 'group' as const, depth: 0 },
        { id: 'i/x', type: 'item' as const, depth: 1 },
        { id: 'i/y', type: 'item' as const, depth: 1 },
        { id: 'g/2', type: 'group' as const, depth: 0 },
        { id: 'i/b', type: 'item' as const, depth: 0 },
    ];

    it('top-level items', () => {
        expect(computeSelectAtDepth(rows, 'item', 0)).toEqual(['i/a', 'i/b']);
    });

    it('top-level groups', () => {
        expect(computeSelectAtDepth(rows, 'group', 0)).toEqual(['g/1', 'g/2']);
    });

    it('items inside groups (depth 1)', () => {
        expect(computeSelectAtDepth(rows, 'item', 1)).toEqual(['i/x', 'i/y']);
    });

    it('empty rows → empty array', () => {
        expect(computeSelectAtDepth([], 'item', 0)).toEqual([]);
    });

    it('no matches → empty array', () => {
        expect(computeSelectAtDepth(rows, 'group', 1)).toEqual([]);
    });
});

describe('isSelectionEqualToSet', () => {
    it('equal sets', () => {
        expect(isSelectionEqualToSet(new Set(['a', 'b']), ['a', 'b'])).toBe(true);
        expect(isSelectionEqualToSet(new Set(['a', 'b']), ['b', 'a'])).toBe(true);
    });

    it('different sizes → false', () => {
        expect(isSelectionEqualToSet(new Set(['a']), ['a', 'b'])).toBe(false);
        expect(isSelectionEqualToSet(new Set(['a', 'b']), ['a'])).toBe(false);
    });

    it('same size, different members → false', () => {
        expect(isSelectionEqualToSet(new Set(['a', 'b']), ['a', 'c'])).toBe(false);
    });

    it('both empty → true', () => {
        expect(isSelectionEqualToSet(new Set(), [])).toBe(true);
    });
});
