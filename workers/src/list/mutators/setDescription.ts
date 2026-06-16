import { z } from 'zod';

import { NotFoundError } from '@djibb/protocol/errors';
import { ListSchema } from '@djibb/protocol/list';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * Description is free-form prose; an empty string clears it. We don't
 * model a separate "unset" state — the SQL column defaults to "" and
 * the entity schema's `description` is optional, so an empty string
 * round-trips cleanly through both.
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    description: z.string().max(10_000),
    /** Narrow set-family CAS; see renameList for full notes. */
    expected: z
        .object({
            description: z.string(),
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setDescription' as const;
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    { listId, description, expected },
    { store, nextVersion }
) => {
    if (expected?.description !== undefined) {
        const row = store.getLiveEntityCasRow(listId);
        if (!row) return { status: 'gone' };
        // Description column defaults to '' so a null read here would
        // be unusual, but normalize defensively.
        const current = row.description ?? '';
        if (current !== expected.description) return { status: 'stale' };
    }
    store.setEntityDescription({
        entityId: listId,
        description,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, description, expected },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`entity "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & { version?: number };

    if (expected?.description !== undefined) {
        const current = (entity.description as string | undefined) ?? '';
        if (current !== expected.description) return;
    }

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

export const capturePreState: CapturePreState<Args> = async (tx, { listId }) => {
    const raw = await tx.get(listId);
    if (!raw) return {};
    const entity = raw as Record<string, unknown>;
    return { description: (entity.description as string | undefined) ?? '' };
};

export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || preState.description === undefined) return null;
    return {
        name,
        args: {
            listId: args.listId,
            description: preState.description,
            expected: { description: args.description },
        },
    };
};
