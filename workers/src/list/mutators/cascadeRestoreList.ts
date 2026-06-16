import { z } from 'zod';

import { ID_LENGTH, IdTypes } from '@djibb/protocol/id';
import { SYSTEM_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';

/**
 * Cascade-restore a List or Template as part of a Workspace's
 * cascade-restore sweep (ADR 0008, ADR 0011 §Step 10a.5).
 *
 * The system-only sibling of `unarchiveList`. The user-facing
 * `unarchiveList` is invoked from a human session (Cmd+Z on an
 * archive, or — in the future — a per-entity Restore button in the
 * Trash UI) and operates on entities that were user-archived; this
 * mutator is invoked only by the parent Workspace DO via the
 * cascade-restore sweep and operates on entities that were
 * cascade-archived (their `cascade_source` points back at the
 * driving workspace).
 *
 * `unarchiveEntity` clears both `time_deleted` AND `cascade_source`
 * symmetrically — see `archiveEntity` / `unarchiveEntity` in sql.ts.
 * That symmetry is what makes the workspace handler self-progressing
 * without a cursor: each cascade restore drops the child out of the
 * next batch's `cascade_source = ?` predicate naturally.
 *
 * Inverse is `null`, matching `cascadeArchiveList`: cascade-restore is
 * not user-undoable through the Replicache undo stack. If the user
 * wants to re-archive after a restore, they go back through
 * `archiveList` on the workspace, which re-triggers the cascade.
 */

// Lists and Templates only — symmetric with `cascadeArchiveList`.
const LIST_ID_LENGTH = ID_LENGTH + IdTypes.list.length + 1;
const TEMPLATE_ID_LENGTH = ID_LENGTH + IdTypes.template.length + 1;
const WORKSPACE_ID_LENGTH = ID_LENGTH + IdTypes.workspace.length + 1;

const ListOrTemplateIdSchema = z
    .string()
    .refine(
        id =>
            (id.startsWith(`${IdTypes.list}/`) &&
                id.length === LIST_ID_LENGTH) ||
            (id.startsWith(`${IdTypes.template}/`) &&
                id.length === TEMPLATE_ID_LENGTH),
        {
            message: 'cascade target must be a list or template id',
        }
    );

const WorkspaceIdSchema = z
    .string()
    .startsWith(`${IdTypes.workspace}/`)
    .length(WORKSPACE_ID_LENGTH);

export const argsSchema = z.object({
    listId: ListOrTemplateIdSchema,
    /**
     * The workspace driving this restore. Required for symmetry with
     * `cascadeArchiveList` and for log-readability (a glance at the
     * mutation log entry tells you which workspace's restore sweep
     * brought this entity back). Not used for runtime gating on the
     * child — the system-role check + the workspace-side SELECT
     * predicate (`cascade_source = self`) are the gates that matter.
     */
    cascade_source: WorkspaceIdSchema,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'cascadeRestoreList' as const;
export const requiredRole = SYSTEM_ROLES;

export const server: ServerMutator<Args> = (
    { listId },
    { store, nextVersion }
) => {
    store.unarchiveEntity({ entityId: listId, version: nextVersion });
};

/**
 * Client mutator — like `cascadeArchiveList`'s, this runs in the
 * synthetic-client context, which has no local Replicache cache that
 * a real user reads. Cosmetic optimistic-state shape for any future
 * client-side replay; the user-visible cache lives on the human's
 * clients (different DOs) and gets the restore via their pull
 * snapshot.
 */
export const client: ClientMutator<Args> = async (
    tx,
    { listId },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        // Cascade target may not be in this client's cache at all.
        // No error: the workspace's restore sweep is the source of
        // truth; the child DO's pull will deliver the restored row
        // to any connected user clients.
        return;
    }
    const entity = raw as Record<string, unknown> & { version?: number };
    const ts = timestamp_client ?? new Date();
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            time_deleted: null,
            // Mirror the server's clear: a restored entity carries no
            // breadcrumb forward, so a subsequent unrelated cascade
            // sweep can't pick it up under an old workspace id.
            cascade_source: null,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

export const inverse: Inverse<Args> = () => null;
