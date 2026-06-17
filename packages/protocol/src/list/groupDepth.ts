/**
 * Group-nesting invariant (ADR 0012 §G, option B).
 *
 * Markdown can only spell group depths 0–{@link MAX_DEPTH} (`##`–`######`),
 * and JSON must not hold a structure Markdown can't round-trip — so the depth
 * ceiling is a *write-side* invariant, not just a parser clamp. This module is
 * the pure check; mutators that create or reparent groups call it and reject a
 * payload that would bust the ceiling or form a cycle.
 *
 * It is deliberately dependency-free (no DO, no Zod) so it can be unit-tested
 * in isolation, like the rest of the content layer.
 */

import { MAX_DEPTH } from './markdown';

/** The smallest shape of a group this check needs. */
export interface GroupNode {
    id: string;
    child_element_refs: string[];
}

export interface GroupTreeViolation {
    /** The group at fault. */
    groupId: string;
    /** `depth`: nested past {@link MAX_DEPTH}. `cycle`: reachable from itself. */
    reason: 'depth' | 'cycle';
}

/**
 * Walk the group tree rooted at `childElementRefs` (the entity's top-level
 * children) and return the first violation, or `null` if the tree is sound.
 *
 * Top-level groups are depth 0; a subgroup is one deeper than its parent. Only
 * ids present in `groups` are treated as groups — item ids in a group's
 * `child_element_refs` are simply ignored (items don't count toward the group
 * ceiling). A group reached twice is reported as a `cycle`: in a tree each
 * group has exactly one parent, so a second visit means either a true cycle or
 * an illegal shared subtree — both are rejected.
 */
export function findGroupTreeViolation(
    childElementRefs: string[],
    groups: GroupNode[]
): GroupTreeViolation | null {
    const byId = new Map<string, GroupNode>();
    for (const g of groups) byId.set(g.id, g);

    const seen = new Set<string>();

    /** @returns the first violation found in this subtree, or null. */
    const walk = (refs: string[], depth: number): GroupTreeViolation | null => {
        for (const ref of refs) {
            const group = byId.get(ref);
            if (!group) continue; // an item, or a dangling ref — not a group.
            if (seen.has(ref)) return { groupId: ref, reason: 'cycle' };
            seen.add(ref);
            if (depth > MAX_DEPTH) return { groupId: ref, reason: 'depth' };
            const sub = walk(group.child_element_refs, depth + 1);
            if (sub) return sub;
        }
        return null;
    };

    return walk(childElementRefs, 0);
}
