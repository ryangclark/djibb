// Write-side group-nesting invariant (ADR 0012 §G). Pure: the same
// cross-package pattern as markdown / listViewSequence — no DO needed.

import { describe, it, expect } from 'vitest';

import {
    findGroupTreeViolation,
    type GroupNode,
} from '@djibb/protocol/list/groupDepth';
import { MAX_DEPTH } from '@djibb/protocol/list/markdown';

/** Build a straight chain g0 -> g1 -> ... of `levels` nested groups. */
function chain(levels: number): { topRefs: string[]; groups: GroupNode[] } {
    const groups: GroupNode[] = [];
    for (let i = 0; i < levels; i++) {
        const child = i < levels - 1 ? [`g/${i + 1}`] : [];
        groups.push({ id: `g/${i}`, child_element_refs: child });
    }
    return { topRefs: ['g/0'], groups };
}

describe('findGroupTreeViolation', () => {
    it('passes a flat list of groups (all depth 0)', () => {
        const groups: GroupNode[] = [
            { id: 'g/a', child_element_refs: ['i/1'] },
            { id: 'g/b', child_element_refs: [] },
        ];
        expect(findGroupTreeViolation(['g/a', 'g/b'], groups)).toBeNull();
    });

    it('ignores item refs (items never count toward the ceiling)', () => {
        const groups: GroupNode[] = [{ id: 'g/a', child_element_refs: ['i/1', 'i/2'] }];
        expect(findGroupTreeViolation(['i/loose', 'g/a'], groups)).toBeNull();
    });

    it('passes a chain exactly at the ceiling (depth 0..MAX_DEPTH)', () => {
        // MAX_DEPTH = 4 means 5 levels of group are allowed.
        const { topRefs, groups } = chain(MAX_DEPTH + 1);
        expect(findGroupTreeViolation(topRefs, groups)).toBeNull();
    });

    it('rejects a chain one level past the ceiling', () => {
        const { topRefs, groups } = chain(MAX_DEPTH + 2);
        const v = findGroupTreeViolation(topRefs, groups);
        expect(v).toEqual({ groupId: `g/${MAX_DEPTH + 1}`, reason: 'depth' });
    });

    it('rejects a direct cycle (a -> b -> a)', () => {
        const groups: GroupNode[] = [
            { id: 'g/a', child_element_refs: ['g/b'] },
            { id: 'g/b', child_element_refs: ['g/a'] },
        ];
        expect(findGroupTreeViolation(['g/a'], groups)).toEqual({
            groupId: 'g/a',
            reason: 'cycle',
        });
    });

    it('rejects a self-cycle', () => {
        const groups: GroupNode[] = [{ id: 'g/a', child_element_refs: ['g/a'] }];
        expect(findGroupTreeViolation(['g/a'], groups)).toEqual({
            groupId: 'g/a',
            reason: 'cycle',
        });
    });

    it('rejects a group reachable from two parents (illegal shared subtree)', () => {
        const groups: GroupNode[] = [
            { id: 'g/a', child_element_refs: ['g/shared'] },
            { id: 'g/b', child_element_refs: ['g/shared'] },
            { id: 'g/shared', child_element_refs: [] },
        ];
        expect(findGroupTreeViolation(['g/a', 'g/b'], groups)).toEqual({
            groupId: 'g/shared',
            reason: 'cycle',
        });
    });
});
