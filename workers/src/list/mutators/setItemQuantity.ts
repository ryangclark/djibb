import { z } from 'zod';

import { QuantitySchema } from '@djibb/protocol/list';
import { NotFoundError } from '../../errors';
import { ID_LENGTH, IdTypes } from '@djibb/protocol/id';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

export const argsSchema = z.object({
    itemId: z.string().length(ID_LENGTH + IdTypes['item'].length + 1),
    quantity: QuantitySchema,
    /**
     * Narrow set-family CAS. Compared against the current `value`
     * column on the item row before applying. Any mismatch silently
     * no-ops (ADR 0005).
     */
    expected: z
        .object({
            quantity: QuantitySchema,
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setItemQuantity' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { itemId, quantity, expected },
    { sql, store, nextVersion }
) => {
    if (expected?.quantity !== undefined) {
        const rows = sql
            .exec(
                `SELECT value FROM list_elements
                 WHERE id = ?
                   AND type = 'item'
                   AND time_deleted IS NULL;`,
                itemId
            )
            .toArray();
        const row = rows[0];
        if (!row) return { status: 'gone' };
        const currentRaw = row.value;
        const current =
            typeof currentRaw === 'string' ? JSON.parse(currentRaw) : currentRaw;
        if (JSON.stringify(current) !== JSON.stringify(expected.quantity)) {
            return { status: 'stale' };
        }
    }
    store.setItemValueAndVersion({
        itemId,
        value: quantity,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { itemId, quantity, expected },
    { timestamp_client }
) => {
    const raw = await tx.get(itemId);
    if (!raw) {
        throw new NotFoundError(`item "${itemId}" not found`);
    }
    const item = raw as any;

    if (expected?.quantity !== undefined) {
        if (
            JSON.stringify(item.value) !== JSON.stringify(expected.quantity)
        ) {
            return;
        }
    }

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

export const capturePreState: CapturePreState<Args> = async (tx, { itemId }) => {
    const raw = await tx.get(itemId);
    if (!raw) return {};
    const item = raw as Record<string, unknown>;
    return { quantity: item.value };
};

export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || preState.quantity === undefined) return null;
    return {
        name,
        args: {
            itemId: args.itemId,
            quantity: preState.quantity,
            expected: { quantity: args.quantity },
        },
    };
};
