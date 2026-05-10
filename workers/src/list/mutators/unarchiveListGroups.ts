import { z } from 'zod';

import { ListGroupSchema } from '..';
import { unarchiveListGroups as unarchiveListGroupsSql } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

export const argsSchema = z.object({
    ids: z.array(ListGroupSchema.shape.id),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'unarchiveListGroups' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { ids },
    { sql, nextVersion }
) => {
    unarchiveListGroupsSql(sql, { groupIds: ids, version: nextVersion });
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
        const group = raw as Record<string, unknown> & { version?: number };
        await tx.set(
            id,
            toStoredValue({
                ...group,
                time_deleted: null,
                time_updated: ts.toISOString(),
                version: (group.version ?? 0) + 1,
            })
        );
    }
};

export const inverse: Inverse<Args> = ({ ids }) => ({
    name: 'archiveListGroups',
    args: { ids },
});
