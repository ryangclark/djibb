import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { ListSchema } from '..';
import { archiveEntity } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';

export const argsSchema = z.object({
    listId: ListSchema.shape.id,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'archiveList' as const;
/**
 * Permissive on purpose — checker and editor can already mutate every
 * piece of list state; archiving is "this is done, hide it" which fits
 * the same trust model as toggling items off. If the project later
 * tightens this to OWNER_ROLES, the catalog and pull machinery don't
 * need to change; only the dispatch gate does.
 */
export const requiredRole = EDIT_ROLES;

/**
 * Soft-delete the entity row. The pull handler emits a `del` op for
 * any element with `time_deleted` set, so the entity disappears from
 * connected clients on the next pull. The catalog read index also
 * filters soft-deleted rows, so the post-commit emit removes the
 * entity from picker results.
 *
 * Items under the entity are not touched. Cheap to leave them; an
 * eventual unarchive flow restores the entity row and the items are
 * still there. Hard delete + cascade is a separate, larger feature.
 */
export const server: ServerMutator<Args> = (
    { listId },
    { sql, nextVersion }
) => {
    archiveEntity(sql, { entityId: listId, version: nextVersion });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`entity "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & { version?: number };
    const ts = timestamp_client ?? new Date();

    // Optimistic: write the soft-delete locally so the UI hides the
    // entity immediately. The server's pull will follow up with a
    // `del` op against the same key; both reach the same end state.
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            time_deleted: ts.toISOString(),
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

/**
 * Archive/restore inverse: pair is `unarchiveList`. ADR 0005 also
 * flags entity-level archive as friction-tier when it crosses the
 * structural-threshold question (deletes that change list visibility
 * for other accounts) — Cmd+Z still works, but the toast surfaces a
 * confirm prompt. The friction lookup happens in the runtime (B.2);
 * this file just declares the inverse pair.
 */
export const inverse: Inverse<Args> = ({ listId }) => ({
    name: 'unarchiveList',
    args: { listId },
});
