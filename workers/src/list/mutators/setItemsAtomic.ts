import { z } from 'zod';

import { ListItemSchema, QuantitySchema } from '@djibb/protocol/list';
import { NotFoundError } from '../../errors';
import { updateListItemsFieldsAtomic } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * Bulk umbrella set-family for items. Same per-entry shape as
 * `setItemFields`; the bulk wrapper makes the entire batch
 * all-or-nothing under CAS (ADR 0005 §"Defensive conflict policy").
 *
 * Used by keymap surfaces (D.3): bulk `Space` / edit-panel commit
 * across a multi-row selection.
 */
const FieldsSchema = z
    .object({
        description: z.string(),
        name: z.string(),
        parent_element_ref: z.string(),
        references_entity_id: z.string().nullable(),
        value: QuantitySchema,
    })
    .partial()
    .strict();

const EntrySchema = z.object({
    id: ListItemSchema.shape.id,
    fields: FieldsSchema,
    expected: FieldsSchema.optional(),
});

export const argsSchema = z.object({
    items: z.array(EntrySchema),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setItemsAtomic' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { items },
    { sql, nextVersion }
) => {
    const outcome = updateListItemsFieldsAtomic(sql, {
        entries: items.map(e => ({
            itemId: e.id,
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
    { items },
    { timestamp_client }
) => {
    // Pass 1: read all and CAS-check. Same all-or-nothing semantics
    // as the server.
    const reads: { entry: typeof items[number]; current: Record<string, unknown> }[] = [];
    for (const entry of items) {
        const raw = await tx.get(entry.id);
        if (!raw) {
            throw new NotFoundError(`item "${entry.id}" not found`);
        }
        const current = raw as Record<string, unknown>;
        if (entry.expected) {
            for (const [k, v] of Object.entries(entry.expected)) {
                if (JSON.stringify(current[k]) !== JSON.stringify(v)) return;
            }
        }
        reads.push({ entry, current });
    }

    // Pass 2: apply.
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

/**
 * Snapshots per-entry pre-state. Threaded through `inverse` as
 * `{ items: [{ id, pre }] }`. `pre` contains only the keys present in
 * that entry's `fields`.
 */
export const capturePreState: CapturePreState<Args> = async (tx, { items }) => {
    const snapshots: { id: string; pre: Record<string, unknown> }[] = [];
    for (const entry of items) {
        const raw = await tx.get(entry.id);
        if (!raw) continue;
        const current = raw as Record<string, unknown>;
        const pre: Record<string, unknown> = {};
        for (const k of Object.keys(entry.fields)) {
            pre[k] = current[k];
        }
        snapshots.push({ id: entry.id, pre });
    }
    return { items: snapshots };
};

export const inverse: Inverse<Args> = (args, preState) => {
    const snapshots = preState?.items as
        | { id: string; pre: Record<string, unknown> }[]
        | undefined;
    if (!snapshots || snapshots.length === 0) return null;
    const preById = new Map(snapshots.map(s => [s.id, s.pre]));

    const inverseItems = args.items
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

    if (inverseItems.length === 0) return null;
    return { name, args: { items: inverseItems } };
};
