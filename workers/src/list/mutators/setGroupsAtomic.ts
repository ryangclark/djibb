import { z } from 'zod';

import { ListGroupSchema } from '..';
import { NotFoundError } from '../../errors';
import { updateListGroupsFieldsAtomic } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * Bulk umbrella set-family for groups. Symmetric to `setItemsAtomic`.
 * All-or-nothing CAS across the batch.
 */
const FieldsSchema = z
    .object({
        description: z.string(),
        name: z.string(),
        parent_element_ref: z.string(),
    })
    .partial()
    .strict();

const EntrySchema = z.object({
    id: ListGroupSchema.shape.id,
    fields: FieldsSchema,
    expected: FieldsSchema.optional(),
});

export const argsSchema = z.object({
    groups: z.array(EntrySchema),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setGroupsAtomic' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { groups },
    { sql, nextVersion }
) => {
    const outcome = updateListGroupsFieldsAtomic(sql, {
        entries: groups.map(e => ({
            groupId: e.id,
            fields: e.fields,
            expected: e.expected,
        })),
        version: nextVersion,
    });
    if (outcome === 'stale' || outcome === 'gone') {
        return { status: outcome };
    }
};

export const client: ClientMutator<Args> = async (
    tx,
    { groups },
    { timestamp_client }
) => {
    const reads: { entry: typeof groups[number]; current: Record<string, unknown> }[] = [];
    for (const entry of groups) {
        const raw = await tx.get(entry.id);
        if (!raw) {
            throw new NotFoundError(`group "${entry.id}" not found`);
        }
        const current = raw as Record<string, unknown>;
        if (entry.expected) {
            for (const [k, v] of Object.entries(entry.expected)) {
                if (JSON.stringify(current[k]) !== JSON.stringify(v)) return;
            }
        }
        reads.push({ entry, current });
    }

    const ts = timestamp_client ?? new Date();
    for (const { entry, current } of reads) {
        await tx.set(
            entry.id,
            toStoredValue({
                ...current,
                ...entry.fields,
                time_updated: ts.toISOString(),
                version: ((current.version as number | undefined) ?? 0) + 1,
            })
        );
    }
};

export const capturePreState: CapturePreState<Args> = async (
    tx,
    { groups }
) => {
    const snapshots: { id: string; pre: Record<string, unknown> }[] = [];
    for (const entry of groups) {
        const raw = await tx.get(entry.id);
        if (!raw) continue;
        const current = raw as Record<string, unknown>;
        const pre: Record<string, unknown> = {};
        for (const k of Object.keys(entry.fields)) {
            pre[k] = current[k];
        }
        snapshots.push({ id: entry.id, pre });
    }
    return { groups: snapshots };
};

export const inverse: Inverse<Args> = (args, preState) => {
    const snapshots = preState?.groups as
        | { id: string; pre: Record<string, unknown> }[]
        | undefined;
    if (!snapshots || snapshots.length === 0) return null;
    const preById = new Map(snapshots.map(s => [s.id, s.pre]));

    const inverseGroups = args.groups
        .map(entry => {
            const pre = preById.get(entry.id);
            if (!pre || Object.keys(pre).length === 0) return null;
            return {
                id: entry.id,
                fields: pre,
                expected: entry.fields,
            };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

    if (inverseGroups.length === 0) return null;
    return { name, args: { groups: inverseGroups } };
};
