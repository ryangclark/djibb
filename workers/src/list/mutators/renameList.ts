import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { ListSchema } from '..';
import { renameEntity } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, ServerMutator } from './_shared';

export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    name: z.string().min(1).max(200),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'renameList' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { listId, name: newName },
    { sql, nextVersion }
) => {
    renameEntity(sql, { entityId: listId, name: newName, version: nextVersion });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, name: newName },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`entity "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & { version?: number };
    const ts = timestamp_client ?? new Date();

    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            name: newName,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};
