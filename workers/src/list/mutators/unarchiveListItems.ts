import { z } from 'zod';

import { ListItemSchema } from '@djibb/protocol/list';
import { unarchiveListItems as unarchiveListItemsSql } from '../sql';
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

export const name = 'unarchiveListItems' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { ids },
    { sql, nextVersion }
) => {
    unarchiveListItemsSql(sql, { itemIds: ids, version: nextVersion });
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
                time_deleted: null,
                time_updated: ts.toISOString(),
                version: (item.version ?? 0) + 1,
            })
        );
    }
};

export const inverse: Inverse<Args> = ({ ids }) => ({
    name: 'archiveListItems',
    args: { ids },
});
