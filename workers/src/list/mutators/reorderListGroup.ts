import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { ListGroupSchema } from '..';
import { reorderChildElement } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * Reorder a group within its current parent's `child_element_refs`.
 * Symmetric to `reorderListItem`. Cross-parent group moves go through
 * `setGroupFields` (parent_element_ref).
 */
export const argsSchema = z.object({
    id: ListGroupSchema.shape.id,
    toIndex: z.number().int().nonnegative(),
    expected: z
        .object({
            fromIndex: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'reorderListGroup' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { id, toIndex, expected },
    { sql, nextVersion }
) => {
    const rows = sql
        .exec(
            `SELECT parent_element_ref FROM list_elements
             WHERE id = ? AND type = 'group' AND time_deleted IS NULL;`,
            id
        )
        .toArray();
    const row = rows[0];
    if (!row) return;
    const parentId = row['parent_element_ref'] as string;

    reorderChildElement(sql, {
        parentId,
        childId: id,
        toIndex,
        expectedFromIndex: expected?.fromIndex,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { id, toIndex, expected },
    { timestamp_client }
) => {
    const rawGroup = await tx.get(id);
    if (!rawGroup) {
        throw new NotFoundError(`group "${id}" not found`);
    }
    const group = rawGroup as Record<string, unknown>;
    const parentId = group.parent_element_ref as string;

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

export const capturePreState: CapturePreState<Args> = async (tx, { id }) => {
    const raw = await tx.get(id);
    if (!raw) return {};
    const group = raw as Record<string, unknown>;
    const parentId = group.parent_element_ref as string | undefined;
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
