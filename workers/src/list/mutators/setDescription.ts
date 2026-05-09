import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { ListSchema } from '..';
import { setEntityDescription } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, ServerMutator } from './_shared';

/**
 * Description is free-form prose; an empty string clears it. We don't
 * model a separate "unset" state — the SQL column defaults to "" and
 * the entity schema's `description` is optional, so an empty string
 * round-trips cleanly through both.
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    description: z.string().max(10_000),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setDescription' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { listId, description },
    { sql, nextVersion }
) => {
    setEntityDescription(sql, {
        entityId: listId,
        description,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, description },
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
            description,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};
