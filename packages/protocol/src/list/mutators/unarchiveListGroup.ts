import { z } from 'zod';

import { ListGroupSchema } from '@djibb/protocol/list';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

export const argsSchema = z.object({
    id: ListGroupSchema.shape.id,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'unarchiveListGroup' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = ({ id }, { store, nextVersion }) => {
    store.unarchiveListGroup({ groupId: id, version: nextVersion });
};

export const client: ClientMutator<Args> = async (
    tx,
    { id },
    { timestamp_client }
) => {
    const raw = await tx.get(id);
    if (!raw) return;
    const group = raw as Record<string, unknown> & { version?: number };
    const ts = timestamp_client ?? new Date();
    await tx.set(
        id,
        toStoredValue({
            ...group,
            time_deleted: null,
            time_updated: ts.toISOString(),
            version: (group.version ?? 0) + 1,
        })
    );
};

export const inverse: Inverse<Args> = ({ id }) => ({
    name: 'archiveListGroup',
    args: { id },
});
