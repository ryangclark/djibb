import { z } from 'zod';

import { ListItemSchema } from '..';
import { unarchiveListItem as unarchiveListItemSql } from '../sql';
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

export const name = 'unarchiveListItem' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = ({ id }, { sql, nextVersion }) => {
    unarchiveListItemSql(sql, { itemId: id, version: nextVersion });
};

export const client: ClientMutator<Args> = async (
    tx,
    { id },
    { timestamp_client }
) => {
    const raw = await tx.get(id);
    // Item may not be in the local cache (pull sent `del` after archive).
    // Skip the optimistic write; server pull will deliver the restored row.
    if (!raw) return;
    const item = raw as Record<string, unknown> & { version?: number };
    const ts = timestamp_client ?? new Date();
    await tx.set(
        id,
        toStoredValue({
            ...item,
            time_deleted: null,
            time_updated: ts.toISOString(),
            version: (item.version ?? 0) + 1,
        })
    );
};

export const inverse: Inverse<Args> = ({ id }) => ({
    name: 'archiveListItem',
    args: { id },
});
