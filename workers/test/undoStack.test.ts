import { describe, it, expect } from 'vitest';

// B.2: pure stack mechanics for the undo runtime. No Svelte deps;
// these helpers are the bookkeeping that withUndo.svelte.js delegates
// to. Tested here because pages doesn't have a vitest harness today
// and the workers pool can resolve the cross-package relative import.

import {
    coalesceReorderEntry,
    loadStack,
    popLast,
    pruneByMutationID,
    pushWithLimit,
    saveStack,
    stackStorageKey,
    STACK_LIMIT,
    tryCoalesce,
} from '../../pages/src/lib/replicache/undoStack.js';

class MemoryStorage {
    private data = new Map<string, string>();
    getItem(k: string) {
        return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string) {
        this.data.set(k, v);
    }
    removeItem(k: string) {
        this.data.delete(k);
    }
    clear() {
        this.data.clear();
    }
    key(_i: number): string | null {
        return null;
    }
    get length() {
        return this.data.size;
    }
}

function entry(name: string, t = 0) {
    return {
        forwardName: name,
        forwardArgs: { x: 1 },
        inverseName: `un${name}`,
        inverseArgs: { x: 1 },
        timestamp: t,
    };
}

describe('stackStorageKey', () => {
    it('namespaces per-account, per-list', () => {
        expect(stackStorageKey('acct_a', 'l/abc')).toBe('djibb:undo:acct_a:l/abc');
        expect(stackStorageKey(null, 'l/abc')).toBe('djibb:undo:anon:l/abc');
        expect(stackStorageKey(undefined, 'l/abc')).toBe('djibb:undo:anon:l/abc');
    });
});

describe('pushWithLimit', () => {
    it('appends within limit', () => {
        const next = pushWithLimit([entry('a'), entry('b')], entry('c'));
        expect(next.map(e => e.forwardName)).toEqual(['a', 'b', 'c']);
    });

    it('evicts oldest when over limit', () => {
        const initial = Array.from({ length: 50 }, (_, i) => entry(`m${i}`));
        const next = pushWithLimit(initial, entry('m50'), 50);
        expect(next.length).toBe(50);
        // m0 evicted; m50 is now the tail.
        expect(next[0]?.forwardName).toBe('m1');
        expect(next[49]?.forwardName).toBe('m50');
    });

    it('respects the default STACK_LIMIT', () => {
        const initial = Array.from({ length: STACK_LIMIT }, (_, i) =>
            entry(`m${i}`)
        );
        const next = pushWithLimit(initial, entry('overflow'));
        expect(next.length).toBe(STACK_LIMIT);
        expect(next[STACK_LIMIT - 1]?.forwardName).toBe('overflow');
    });

    it('returns a new array (no mutation)', () => {
        const original = [entry('a')];
        const next = pushWithLimit(original, entry('b'));
        expect(original.length).toBe(1);
        expect(next).not.toBe(original);
    });
});

describe('popLast', () => {
    it('returns the last entry and a shorter array', () => {
        const [next, popped] = popLast([entry('a'), entry('b')]);
        expect(popped?.forwardName).toBe('b');
        expect(next.map(e => e.forwardName)).toEqual(['a']);
    });

    it('returns undefined and the original array when empty', () => {
        const [next, popped] = popLast([]);
        expect(popped).toBeUndefined();
        expect(next).toEqual([]);
    });
});

describe('loadStack / saveStack', () => {
    it('round-trips entries through storage', () => {
        const storage = new MemoryStorage();
        const key = stackStorageKey('acct', 'l/abc');
        const stack = [entry('a', 100), entry('b', 200)];
        saveStack(storage, key, stack);
        expect(loadStack(storage, key)).toEqual(stack);
    });

    it('returns [] when storage is undefined (SSR)', () => {
        expect(loadStack(undefined, 'k')).toEqual([]);
    });

    it('returns [] when key is missing', () => {
        const storage = new MemoryStorage();
        expect(loadStack(storage, 'never-set')).toEqual([]);
    });

    it('returns [] on corrupted JSON', () => {
        const storage = new MemoryStorage();
        storage.setItem('k', '{not json');
        expect(loadStack(storage, 'k')).toEqual([]);
    });

    it('returns [] when the stored value is not an array', () => {
        const storage = new MemoryStorage();
        storage.setItem('k', JSON.stringify({ not: 'an array' }));
        expect(loadStack(storage, 'k')).toEqual([]);
    });

    it('saveStack on undefined storage is a no-op (no throw)', () => {
        expect(() => saveStack(undefined, 'k', [])).not.toThrow();
    });
});

describe('pruneByMutationID', () => {
    function tagged(name: string, mutationID: number | undefined) {
        return { ...entry(name), mutationID };
    }

    it('removes the entry whose mutationID matches', () => {
        const stack = [tagged('a', 1), tagged('b', 2), tagged('c', 3)];
        const [next, removed] = pruneByMutationID(stack, 2);
        expect(removed).toBe(1);
        expect(next.map(e => e.forwardName)).toEqual(['a', 'c']);
    });

    it('removes nothing when no entry matches', () => {
        const stack = [tagged('a', 1), tagged('b', 2)];
        const [next, removed] = pruneByMutationID(stack, 999);
        expect(removed).toBe(0);
        expect(next).toEqual(stack);
    });

    it('leaves untagged entries (capture race) alone', () => {
        // mutationID undefined ↔ best-effort capture missed it. Such
        // entries are never pruned by outcome events.
        const stack = [tagged('a', undefined), tagged('b', 5)];
        const [next, removed] = pruneByMutationID(stack, 5);
        expect(removed).toBe(1);
        expect(next.map(e => e.forwardName)).toEqual(['a']);
    });

    it('removes all entries that share an id (defensive)', () => {
        // Shouldn't happen — IDs are unique per client — but the
        // filter is permissive so duplicates would all go.
        const stack = [tagged('a', 7), tagged('b', 7), tagged('c', 8)];
        const [next, removed] = pruneByMutationID(stack, 7);
        expect(removed).toBe(2);
        expect(next.map(e => e.forwardName)).toEqual(['c']);
    });
});

// B.3: reorder coalescing. Same target within the window merges; the
// merged entry's inverse points back to the *first* move's origin
// with a CAS guard against the latest position.

function reorderEntry({
    id,
    fromIndex,
    toIndex,
    t,
    name = 'reorderListItem',
}: {
    id: string;
    fromIndex: number;
    toIndex: number;
    t: number;
    name?: string;
}) {
    return {
        forwardName: name,
        forwardArgs: { id, toIndex },
        inverseName: name,
        inverseArgs: {
            id,
            toIndex: fromIndex,
            expected: { fromIndex: toIndex },
        },
        timestamp: t,
    };
}

const REORDER_MUTATORS = ['reorderListItem', 'reorderListGroup'] as const;

describe('coalesceReorderEntry', () => {
    it('preserves the inverse toIndex from top, refreshes expected.fromIndex from entry', () => {
        // First move: A from 0 → 2.
        const top = reorderEntry({ id: 'A', fromIndex: 0, toIndex: 2, t: 100 });
        // Second move: A from 2 → 5.
        const next = reorderEntry({ id: 'A', fromIndex: 2, toIndex: 5, t: 300 });

        const merged = coalesceReorderEntry(top, next);

        // forward reflects the latest position.
        expect(merged.forwardArgs).toEqual({ id: 'A', toIndex: 5 });
        // inverse still points back to ORIGINAL position (0)…
        expect((merged.inverseArgs as any).toIndex).toBe(0);
        // …with CAS guard against current (5).
        expect((merged.inverseArgs as any).expected).toEqual({ fromIndex: 5 });
        // timestamp rolls forward.
        expect(merged.timestamp).toBe(300);
    });
});

describe('tryCoalesce', () => {
    it('merges same-target same-mutator within the window', () => {
        const stack = [
            reorderEntry({ id: 'A', fromIndex: 0, toIndex: 2, t: 100 }),
        ];
        const next = reorderEntry({ id: 'A', fromIndex: 2, toIndex: 5, t: 400 });
        const result = tryCoalesce(stack, next, REORDER_MUTATORS, 500);
        expect(result).not.toBeNull();
        expect((result as any).inverseArgs.toIndex).toBe(0);
    });

    it('returns null when outside the window', () => {
        const stack = [
            reorderEntry({ id: 'A', fromIndex: 0, toIndex: 2, t: 100 }),
        ];
        const next = reorderEntry({ id: 'A', fromIndex: 2, toIndex: 5, t: 700 });
        expect(tryCoalesce(stack, next, REORDER_MUTATORS, 500)).toBeNull();
    });

    it('returns null when target id differs', () => {
        const stack = [
            reorderEntry({ id: 'A', fromIndex: 0, toIndex: 2, t: 100 }),
        ];
        const next = reorderEntry({ id: 'B', fromIndex: 1, toIndex: 4, t: 200 });
        expect(tryCoalesce(stack, next, REORDER_MUTATORS, 500)).toBeNull();
    });

    it('returns null when mutator name differs (reorder ↔ archive)', () => {
        const stack = [
            reorderEntry({ id: 'A', fromIndex: 0, toIndex: 2, t: 100 }),
        ];
        const next = {
            forwardName: 'archiveListItem',
            forwardArgs: { id: 'A' },
            inverseName: 'unarchiveListItem',
            inverseArgs: { id: 'A' },
            timestamp: 200,
        };
        expect(tryCoalesce(stack, next, REORDER_MUTATORS, 500)).toBeNull();
    });

    it('returns null when the mutator is not in the coalescing registry', () => {
        // setItemFields IS a set-family mutator but isn't on the list.
        const entry1 = {
            forwardName: 'setItemFields',
            forwardArgs: { id: 'A', fields: { name: 'X' } },
            inverseName: 'setItemFields',
            inverseArgs: { id: 'A', fields: { name: 'Y' } },
            timestamp: 100,
        };
        const entry2 = { ...entry1, timestamp: 200 };
        expect(
            tryCoalesce([entry1], entry2, REORDER_MUTATORS, 500)
        ).toBeNull();
    });

    it('returns null when the stack is empty', () => {
        const next = reorderEntry({ id: 'A', fromIndex: 0, toIndex: 2, t: 100 });
        expect(tryCoalesce([], next, REORDER_MUTATORS, 500)).toBeNull();
    });

    it('chains: three rapid moves collapse to one entry whose inverse hits the original', () => {
        let stack: ReturnType<typeof reorderEntry>[] = [];

        const first = reorderEntry({ id: 'A', fromIndex: 0, toIndex: 2, t: 100 });
        stack = [first];

        const second = reorderEntry({ id: 'A', fromIndex: 2, toIndex: 5, t: 200 });
        const merged2 = tryCoalesce(stack, second, REORDER_MUTATORS, 500);
        expect(merged2).not.toBeNull();
        stack = [merged2!];

        const third = reorderEntry({ id: 'A', fromIndex: 5, toIndex: 8, t: 300 });
        const merged3 = tryCoalesce(stack, third, REORDER_MUTATORS, 500);
        expect(merged3).not.toBeNull();

        // After three moves: forward is "go to 8", inverse is "go back to 0".
        expect((merged3 as any).forwardArgs.toIndex).toBe(8);
        expect((merged3 as any).inverseArgs.toIndex).toBe(0);
        expect((merged3 as any).inverseArgs.expected.fromIndex).toBe(8);
    });
});
