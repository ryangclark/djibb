import { z } from 'zod';

import { ListItemSchema } from '@djibb/protocol/list';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

export const argsSchema = z.object({
    ids: z.array(ListItemSchema.shape.id),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'archiveListItems' as const;
export const requiredRole = EDIT_ROLES;

/**
 * Bulk soft-delete. Used by keymap surfaces (D.3): `Cmd+Backspace`
 * across a multi-row selection. Each id is best-effort — missing rows
 * are silently skipped, matching the single-mutator policy.
 */
export const server: ServerMutator<Args> = (
    { ids },
    { store, nextVersion }
) => {
    store.archiveListItems({ itemIds: ids, version: nextVersion });
};

export const client: ClientMutator<Args> = async (
    tx,
    { ids },
    { timestamp_client }
) => {
    const ts = timestamp_client ?? new Date();
    for (const id of ids) {
        const raw = await tx.get(id);
        if (!raw) continue;
        const item = raw as Record<string, unknown> & { version?: number };
        await tx.set(
            id,
            toStoredValue({
                ...item,
                time_deleted: ts.toISOString(),
                time_updated: ts.toISOString(),
                version: (item.version ?? 0) + 1,
            })
        );
    }
};

export const inverse: Inverse<Args> = ({ ids }) => ({
    name: 'unarchiveListItems',
    args: { ids },
});
