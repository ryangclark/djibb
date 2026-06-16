import { z } from 'zod';

import { ListGroupSchema } from '@djibb/protocol/list';
import { NotFoundError } from '../../errors';
import { updateListGroupFields } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * Writable field surface on a list group. Symmetric to
 * `setItemFields`; `child_element_refs` is excluded — reorder/archive
 * mutators own that array (A.7 / A.5).
 */
const FieldsSchema = z
    .object({
        description: z.string(),
        name: z.string(),
        parent_element_ref: z.string(),
    })
    .partial()
    .strict();

export const argsSchema = z.object({
    id: ListGroupSchema.shape.id,
    fields: FieldsSchema,
    /** CAS pre-check; see setItemFields for full notes. */
    expected: FieldsSchema.optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setGroupFields' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { id, fields, expected },
    { sql, nextVersion }
) => {
    const outcome = updateListGroupFields(sql, {
        groupId: id,
        fields,
        expected,
        version: nextVersion,
    });
    if (outcome === 'stale' || outcome === 'gone') {
        return { status: outcome };
    }
};

export const client: ClientMutator<Args> = async (
    tx,
    { id, fields, expected },
    { timestamp_client }
) => {
    const raw = await tx.get(id);
    if (!raw) {
        throw new NotFoundError(`group "${id}" not found`);
    }
    const group = raw as Record<string, unknown> & { version?: number };

    if (expected) {
        for (const [k, v] of Object.entries(expected)) {
            if (JSON.stringify(group[k]) !== JSON.stringify(v)) return;
        }
    }

    const ts = timestamp_client ?? new Date();
    await tx.set(
        id,
        toStoredValue({
            ...group,
            ...fields,
            time_updated: ts.toISOString(),
            version: (group.version ?? 0) + 1,
        })
    );
};

export const capturePreState: CapturePreState<Args> = async (
    tx,
    { id, fields }
) => {
    const raw = await tx.get(id);
    if (!raw) return {};
    const group = raw as Record<string, unknown>;
    const pre: Record<string, unknown> = {};
    for (const k of Object.keys(fields)) {
        pre[k] = group[k];
    }
    return pre;
};

export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || Object.keys(preState).length === 0) return null;
    return {
        name,
        args: {
            id: args.id,
            fields: preState,
            expected: args.fields,
        },
    };
};
