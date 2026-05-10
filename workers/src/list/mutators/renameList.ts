import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { ListSchema } from '..';
import { renameEntity } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    name: z.string().min(1).max(200),
    /**
     * Narrow set-family CAS pre-check. When present, the server
     * compares the current entity name to `expected.name`; mismatch
     * silently no-ops the mutation. Forward calls don't supply
     * `expected`; undo / redo do. ADR 0005 §"Defensive conflict
     * policy."
     */
    expected: z
        .object({
            name: z.string(),
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'renameList' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { listId, name: newName, expected },
    { sql, nextVersion }
) => {
    if (expected?.name !== undefined) {
        const rows = sql
            .exec(
                `SELECT name FROM list_elements
                 WHERE id = ?
                   AND (type = 'list' OR type = 'template')
                   AND time_deleted IS NULL;`,
                listId
            )
            .toArray();
        const row = rows[0];
        if (!row) return; // gone
        if (row.name !== expected.name) return; // stale
    }
    renameEntity(sql, { entityId: listId, name: newName, version: nextVersion });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, name: newName, expected },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`entity "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & { version?: number };

    if (expected?.name !== undefined && entity.name !== expected.name) return;

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

export const capturePreState: CapturePreState<Args> = async (tx, { listId }) => {
    const raw = await tx.get(listId);
    if (!raw) return {};
    const entity = raw as Record<string, unknown>;
    return { name: entity.name };
};

/**
 * Set-family inverse: same mutator with the prior name as `name` and
 * the post-state name as `expected.name` (CAS guard against another
 * client moving the entity in the interim).
 */
export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || preState.name === undefined) return null;
    return {
        name,
        args: {
            listId: args.listId,
            name: preState.name,
            expected: { name: args.name },
        },
    };
};
