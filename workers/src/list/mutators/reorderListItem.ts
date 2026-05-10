import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { ListItemSchema } from '..';
import { reorderChildElement } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * Reorder a list item within its current parent's
 * `child_element_refs`. Cross-parent moves go through `setItemFields`
 * (parent_element_ref) — this mutator is purely positional.
 *
 * Used by Slice F (`Cmd+↑` / `Cmd+↓`) and the runtime's coalescing
 * logic (B.3): rapid same-element reorders within a 500ms window
 * collapse into a single undo entry whose preState is the position
 * before the *first* move.
 */
export const argsSchema = z.object({
    id: ListItemSchema.shape.id,
    toIndex: z.number().int().nonnegative(),
    /**
     * CAS guard. When present, the server checks the item is
     * currently at `expected.fromIndex` in the parent's array; any
     * other position no-ops the mutation. Forward calls don't supply;
     * undo / redo do.
     */
    expected: z
        .object({
            fromIndex: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'reorderListItem' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { id, toIndex, expected },
    { sql, nextVersion }
) => {
    // Look up the item's current parent so reorder doesn't need a
    // parentId arg (the array invariant lives on the item record).
    const rows = sql
        .exec(
            `SELECT parent_element_ref FROM list_elements
             WHERE id = ? AND type = 'item' AND time_deleted IS NULL;`,
            id
        )
        .toArray();
    const row = rows[0];
    if (!row) return { status: 'gone' };
    const parentId = row['parent_element_ref'] as string;

    const outcome = reorderChildElement(sql, {
        parentId,
        childId: id,
        toIndex,
        expectedFromIndex: expected?.fromIndex,
        version: nextVersion,
    });
    if (outcome === 'stale' || outcome === 'gone') {
        return { status: outcome };
    }
};

export const client: ClientMutator<Args> = async (
    tx,
    { id, toIndex, expected },
    { timestamp_client }
) => {
    const rawItem = await tx.get(id);
    if (!rawItem) {
        throw new NotFoundError(`item "${id}" not found`);
    }
    const item = rawItem as Record<string, unknown>;
    const parentId = item.parent_element_ref as string;

    const rawParent = await tx.get(parentId);
    if (!rawParent) return;
    const parent = rawParent as Record<string, unknown> & {
        version?: number;
        child_element_refs?: string[];
    };
    const refs = [...(parent.child_element_refs ?? [])];
    const fromIndex = refs.indexOf(id);
    if (fromIndex === -1) return;

    if (expected?.fromIndex !== undefined && expected.fromIndex !== fromIndex) {
        return;
    }

    refs.splice(fromIndex, 1);
    const clamped = Math.max(0, Math.min(toIndex, refs.length));
    if (clamped === fromIndex) return;
    refs.splice(clamped, 0, id);

    const ts = timestamp_client ?? new Date();
    await tx.set(
        parentId,
        toStoredValue({
            ...parent,
            child_element_refs: refs,
            time_updated: ts.toISOString(),
            version: (parent.version ?? 0) + 1,
        })
    );
};

/**
 * Snapshot the item's current index in its parent's array. The
 * inverse uses this as the target on undo; the post-state position
 * (`args.toIndex`) goes into `expected` for the CAS guard.
 */
export const capturePreState: CapturePreState<Args> = async (tx, { id }) => {
    const raw = await tx.get(id);
    if (!raw) return {};
    const item = raw as Record<string, unknown>;
    const parentId = item.parent_element_ref as string | undefined;
    if (!parentId) return {};
    const rawParent = await tx.get(parentId);
    if (!rawParent) return {};
    const parent = rawParent as { child_element_refs?: string[] };
    const fromIndex = (parent.child_element_refs ?? []).indexOf(id);
    if (fromIndex === -1) return {};
    return { fromIndex };
};

export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || typeof preState.fromIndex !== 'number') return null;
    return {
        name,
        args: {
            id: args.id,
            toIndex: preState.fromIndex,
            expected: { fromIndex: args.toIndex },
        },
    };
};
