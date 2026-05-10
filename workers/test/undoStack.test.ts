import { describe, it, expect } from 'vitest';

// B.2: pure stack mechanics for the undo runtime. No Svelte deps;
// these helpers are the bookkeeping that withUndo.svelte.js delegates
// to. Tested here because pages doesn't have a vitest harness today
// and the workers pool can resolve the cross-package relative import.

import {
    loadStack,
    popLast,
    pushWithLimit,
    saveStack,
    stackStorageKey,
    STACK_LIMIT,
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
