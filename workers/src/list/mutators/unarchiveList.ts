import { z } from 'zod';

import { ListSchema } from '@djibb/protocol/list';
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
    { sql, store, nextVersion }
) => {
    // ADR 0008 / ADR 0011 §Step 10c: restoring a workspace that was
    // `slot='personal_workspace'` demotes it to an ordinary team
    // workspace. By the time anything in Trash can be restored,
    // `startFresh` has already minted a replacement personal workspace
    // for the actor; preserving the slot here would violate the
    // "exactly one current personal workspace per account" invariant.
    // The user keeps their data; they lose only the "this is THE
    // personal workspace" identity, which the freshly-minted one now
    // holds.
    const row = sql
        .exec(
            `SELECT type, slot FROM list_elements
             WHERE id = ? LIMIT 1`,
            listId
        )
        .toArray()[0] as { type?: string; slot?: string | null } | undefined;
    if (row?.type === 'workspace' && row?.slot === 'personal_workspace') {
        store.unarchiveEntityAndClearSlot({
            entityId: listId,
            version: nextVersion,
        });
        return;
    }
    store.unarchiveEntity({ entityId: listId, version: nextVersion });
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
