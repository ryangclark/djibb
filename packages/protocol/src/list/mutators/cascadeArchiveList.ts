import { z } from 'zod';

import { ID_LENGTH, IdTypes } from '@djibb/protocol/id';
import { SYSTEM_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';

/**
 * Cascade-archive a List or Template as part of a Workspace's
 * cascade-archive sweep (ADR 0008, ADR 0011 §Step 10a).
 *
 * This is the system-only sibling of `archiveList`. The user-facing
 * `archiveList` is invoked by a human's Replicache push and writes
 * `cascade_source = NULL` onto the entity row; this mutator is
 * invoked only by the parent Workspace DO via synthetic-client push
 * (clientID `cascade:w/<id>:<deletionTimestampMs>`) and writes
 * `cascade_source = <workspaceId>`.
 *
 * The two are kept as separate mutators rather than one mutator with
 * a widened `requiredRole`: `requiredRole: SYSTEM_ROLES` carries the
 * full invariant "this row was written by another DO in the cluster,
 * not by any session-bound caller." That invariant is the whole point
 * of the `'system'` role (ADR 0011 §Step 10a.3); if `archiveList`
 * accepted `'system'` callers too, the role check on the cascade path
 * would weaken to a per-arg `if (cascade_source && role !== 'system')`
 * guard inside the body, foot-gunning every future archive change.
 *
 * Inverse is `null`: cascade-archive is not user-undoable through the
 * Replicache undo stack. The Workspace DO's `unarchiveWorkspace`
 * mutator + cascade-restore sweep (10a.5) is the only path that
 * reverses this; users reach it through the Trash UI (10b), not
 * through Cmd+Z.
 */

// Lists and Templates only — Workspaces are not cascade targets
// (a workspace's own delete is the trigger, not a child). The DO
// runtime is shared, so we just constrain the ID prefix here.
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
    cascade_source: WorkspaceIdSchema,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'cascadeArchiveList' as const;
export const requiredRole = SYSTEM_ROLES;

export const server: ServerMutator<Args> = (
    { listId, cascade_source },
    { store, nextVersion }
) => {
    store.archiveEntity({
        entityId: listId,
        version: nextVersion,
        cascadeSource: cascade_source,
    });
};

/**
 * Client mutator runs on the cascading caller (the Workspace DO is
 * not a Replicache client; the synthetic clientID has no local cache).
 * Concretely no one consumes this for optimistic UI — the workspace
 * cascade fans out server-side and the child DOs' pulls propagate
 * the archive to any human clients connected to those children. We
 * still register a client mutator because the Replicache runtime
 * requires every name in the registry to have one, and we mirror the
 * `archiveList` shape so a stray local-side invocation (test fixture,
 * future replay) writes the same optimistic outcome to the cache.
 */
export const client: ClientMutator<Args> = async (
    tx,
    { listId },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        // Cascade target may not be in this client's cache at all.
        // Unlike `archiveList` (a user gesture against a list they're
        // looking at), cascade targets a list the workspace owns
        // somewhere — no error.
        return;
    }
    const entity = raw as Record<string, unknown> & { version?: number };
    const ts = timestamp_client ?? new Date();
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            time_deleted: ts.toISOString(),
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
            // The cascade_source breadcrumb mirrors what the server
            // wrote to the row. Future cascade-restore reads scan by
            // this field; keeping it in the local cache means a
            // client that pulled the cascade and then drove the
            // restore picks up consistent state without a round-trip.
            cascade_source: (raw as { cascade_source?: unknown })
                .cascade_source,
        })
    );
};

// Intentionally non-undoable through the Replicache undo stack. See
// the file-level comment + ADR 0008 §"Friction tier and UX." Restore
// goes through `unarchiveWorkspace` + cascade-restore (10a.5), not
// per-list Cmd+Z.
export const inverse: Inverse<Args> = () => null;
