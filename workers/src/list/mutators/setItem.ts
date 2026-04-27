import { ListItemSchema } from '..';
import { updateListItem } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, ServerMutator } from './_shared';

import { z } from 'zod';

export const argsSchema = ListItemSchema;
export type Args = z.infer<typeof argsSchema>;

export const name = 'setItem' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (item, { sql, nextVersion }) => {
    updateListItem(sql, { ...item, version: nextVersion });
};

export const client: ClientMutator<Args> = async (tx, item) => {
    await tx.set(item.id, toStoredValue(item));
};
