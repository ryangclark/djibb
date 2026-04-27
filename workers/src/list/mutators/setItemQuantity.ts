import { z } from 'zod';

import { QuantitySchema } from '..';
import { NotFoundError } from '../../errors';
import { ID_LENGTH, IdTypes } from '../../id';
import { setItemValueAndVersion } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, ServerMutator } from './_shared';

export const argsSchema = z.object({
    itemId: z.string().length(ID_LENGTH + IdTypes['item'].length + 1),
    quantity: QuantitySchema,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setItemQuantity' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { itemId, quantity },
    { sql, nextVersion }
) => {
    setItemValueAndVersion(sql, {
        itemId,
        value: quantity,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { itemId, quantity },
    { timestamp_client }
) => {
    const raw = await tx.get(itemId);
    if (!raw) {
        throw new NotFoundError(`item "${itemId}" not found`);
    }
    const item = raw as any;
    const ts = timestamp_client ?? new Date();

    await tx.set(
        itemId,
        toStoredValue({
            ...item,
            value: quantity,
            time_updated: ts.toISOString(),
            version: (item.version ?? 0) + 1,
        })
    );
};
