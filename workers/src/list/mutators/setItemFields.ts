import { z } from 'zod';

import { ListItemSchema, QuantitySchema } from '..';
import { NotFoundError } from '../../errors';
import { updateListItemFields } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * Writable field surface on a list item — the umbrella set-family
 * shape from ADR 0005. Callers send only the keys they want to change.
 *
 * Excluded by design:
 *  - `id`, `type`, `time_created` — immutable.
 *  - `version`, `time_updated`    — auto-managed.
 *  - `time_deleted`               — archive/restore goes through its
 *                                   own mutator (A.4).
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

export const argsSchema = z.object({
    id: ListItemSchema.shape.id,
    fields: FieldsSchema,
    /**
     * Optional CAS pre-check. When present, the server compares each
     * listed key to the current row before writing; any mismatch
     * silently no-ops the entire mutation (all-or-nothing per
     * envelope, ADR 0005 §"Defensive conflict policy").
     *
     * Forward calls from the UI don't supply `expected`; undo and
     * redo calls supplied by `withUndo` (B.2) do.
     */
    expected: FieldsSchema.optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setItemFields' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { id, fields, expected },
    { sql, nextVersion }
) => {
    updateListItemFields(sql, {
        itemId: id,
        fields,
        expected,
        version: nextVersion,
    });
    // `stale` and `gone` outcomes are silently dropped here. B.1 wires
    // them to the per-mutation outcome channel (ADR 0006); until then,
    // silent skip matches the existing mutator behavior on conflict.
};

export const client: ClientMutator<Args> = async (
    tx,
    { id, fields, expected },
    { timestamp_client }
) => {
    const raw = await tx.get(id);
    if (!raw) {
        throw new NotFoundError(`item "${id}" not found`);
    }
    const item = raw as Record<string, unknown> & { version?: number };

    if (expected) {
        // Same CAS pre-check the server runs. Avoids dirtying the
        // local cache when the inverse will be silently dropped
        // server-side.
        for (const [k, v] of Object.entries(expected)) {
            if (JSON.stringify(item[k]) !== JSON.stringify(v)) return;
        }
    }

    const ts = timestamp_client ?? new Date();
    await tx.set(
        id,
        toStoredValue({
            ...item,
            ...fields,
            time_updated: ts.toISOString(),
            version: (item.version ?? 0) + 1,
        })
    );
};

/**
 * Snapshot only the keys the inverse will need to restore — exactly
 * the keys present in `args.fields`. Reads from the Replicache cache,
 * so this is a one-line read with no server round-trip.
 */
export const capturePreState: CapturePreState<Args> = async (
    tx,
    { id, fields }
) => {
    const raw = await tx.get(id);
    if (!raw) return {};
    const item = raw as Record<string, unknown>;
    const pre: Record<string, unknown> = {};
    for (const k of Object.keys(fields)) {
        pre[k] = item[k];
    }
    return pre;
};

/**
 * Set-family inverse: the same mutator with `fields` ↔ `expected`
 * swapped. The inverse restores the captured pre-state, but only if
 * current state still matches the post-state we just wrote (the CAS
 * guard). If `preState` is missing or empty, the action wasn't
 * undoable — silent skip.
 */
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
