import { z } from 'zod';

import { ListSchema } from '..';
import { unarchiveEntity } from '../sql';
import { EDIT_ROLES, toStoredValue } from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

export const argsSchema = z.object({
    listId: ListSchema.shape.id,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'unarchiveList' as const;
/**
 * Symmetric to `archiveList` — same role gate. The forward
 * `archiveList` is permissive (EDIT_ROLES); restore mirrors that. A
 * separate "claim ownership" flow gates entity-level auth changes
 * (setListAuthRules), not archive/restore.
 */
export const requiredRole = EDIT_ROLES;

/**
 * Restore a soft-deleted entity row. Pair to `archiveList`. Body
 * touches `time_deleted` on the entity row so this IS in
 * `ENTITY_METADATA_MUTATORS` — the catalog needs to re-index the
 * entity once it returns from soft-delete.
 */
export const server: ServerMutator<Args> = (
    { listId },
    { sql, nextVersion }
) => {
    unarchiveEntity(sql, { entityId: listId, version: nextVersion });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        // The entity may not be in the local cache (pull sent `del`
        // after archive). Server pull will deliver the restored row.
        return;
    }
    const entity = raw as Record<string, unknown> & { version?: number };
    const ts = timestamp_client ?? new Date();
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            time_deleted: null,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

export const inverse: Inverse<Args> = ({ listId }) => ({
    name: 'archiveList',
    args: { listId },
});
