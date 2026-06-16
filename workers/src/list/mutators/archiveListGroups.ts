import { z } from 'zod';

import { ListGroupSchema } from '@djibb/protocol/list';
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

export const name = 'archiveListGroups' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { ids },
    { store, nextVersion }
) => {
    store.archiveListGroups({ groupIds: ids, version: nextVersion });
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
                time_deleted: ts.toISOString(),
                time_updated: ts.toISOString(),
                version: (group.version ?? 0) + 1,
            })
        );
    }
};

export const inverse: Inverse<Args> = ({ ids }) => ({
    name: 'unarchiveListGroups',
    args: { ids },
});
