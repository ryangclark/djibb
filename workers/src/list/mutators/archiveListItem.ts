import { z } from 'zod';

import { ListItemSchema } from '..';
import { archiveListItem as archiveListItemSql } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

export const argsSchema = z.object({
    id: ListItemSchema.shape.id,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'archiveListItem' as const;
export const requiredRole = EDIT_ROLES;

/**
 * Soft-delete one item. Body mutator — touches the item row only,
 * not the entity row, so this is NOT in `ENTITY_METADATA_MUTATORS`.
 * Items remain in `list_elements` with `time_deleted` set; the pull
 * handler emits a `del` op against the row.
 */
export const server: ServerMutator<Args> = ({ id }, { sql, nextVersion }) => {
    archiveListItemSql(sql, { itemId: id, version: nextVersion });
};

export const client: ClientMutator<Args> = async (
    tx,
    { id },
    { timestamp_client }
) => {
    const raw = await tx.get(id);
    if (!raw) return; // already gone locally — server pull will reconcile.
    const item = raw as Record<string, unknown> & { version?: number };
    const ts = timestamp_client ?? new Date();
    await tx.set(
        id,
        toStoredValue({
            ...item,
            time_deleted: ts.toISOString(),
            time_updated: ts.toISOString(),
            version: (item.version ?? 0) + 1,
        })
    );
};

/**
 * Archive/restore inverse: the mirror mutator. No `capturePreState`
 * needed — the id alone is enough to reverse.
 */
export const inverse: Inverse<Args> = ({ id }) => ({
    name: 'unarchiveListItem',
    args: { id },
});
