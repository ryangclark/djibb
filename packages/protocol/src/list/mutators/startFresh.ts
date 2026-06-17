import { z } from 'zod';

import { BadMutationError, NotFoundError } from '@djibb/protocol/errors';
import { WorkspaceEntitySchema } from '@djibb/protocol/list';
import { OWNER_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';

/**
 * Personal-workspace "Start Fresh" verb per ADR 0008 §"Personal
 * Workspace: 'Start Fresh,' not Delete" and ADR 0011 §Step 10c.
 *
 * Mechanically a special-cased `archiveList` on a personal workspace:
 * soft-deletes the current personal workspace (which arms the
 * harddelete clock and triggers the cascade-archive sweep against its
 * children, identically to `archiveList` on a team workspace), and
 * then mints a fresh new personal workspace for the actor so the "one
 * current personal workspace per account" invariant survives the
 * round-trip. The mint runs in the post-commit tail of `_handlePush`
 * because it requires a cross-DO synth push (`mintPersonalWorkspaceEntity`)
 * which the synchronous server-mutator surface cannot do.
 *
 * Why a dedicated mutator instead of widening `archiveList`:
 *
 *   - Distinct verb in the mutation log — operators can audit
 *     `startFresh` events without having to disambiguate from team
 *     workspace deletions.
 *   - Mutator-level guard: `archiveList` rejects personal workspaces
 *     outright; `startFresh` is the only path that can archive one,
 *     and `startFresh` rejects everything *but* a personal workspace.
 *     The pair preserves the "personal workspaces can't be deleted"
 *     invariant without scattering type checks across the UI.
 *   - The post-commit mint hook keys off the mutator name, so the
 *     trigger condition is a single string compare.
 *
 * Not undoable (`inverse: () => null`). The cleanest mental model is
 * "your old contents went to Trash; restore from there if you want
 * them back." A Cmd+Z that magically swapped the personal workspace
 * pointer back would create a window where the freshly-minted
 * workspace had to be torn down, which is ugly to make atomic.
 */
export const argsSchema = z.object({
    workspaceId: WorkspaceEntitySchema.shape.id,
    /**
     * Display name to use when naming the freshly-minted personal
     * workspace. The post-commit tail formats it the same way as
     * signup (`<display_name>'s space`, falling back to `'Personal'`
     * when null). Passing it through args avoids having to look up
     * the actor's account from D1 inside the post-commit tail.
     */
    accountDisplayName: z.string().nullable().optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'startFresh' as const;
/**
 * Personal workspaces have exactly one owner (the account that the
 * workspace was minted for at signup). Anyone else would resolve as
 * `restricted`/non-member; only the personal owner can call this.
 */
export const requiredRole = OWNER_ROLES;

/**
 * Soft-delete the current personal workspace. Same SQL as `archiveList`
 * — `archiveEntity` with no `cascadeSource` (the workspace itself isn't
 * being cascade-archived; its children will be, by the cascade-archive
 * sweep that fires from the post-commit trigger).
 *
 * Validates the target is actually `slot='personal_workspace'`. The
 * UI gates this too, but a defensive throw here means a misrouted
 * client (or a future API surface that bypasses the Settings page)
 * can't silently turn `startFresh` into a glorified `archiveList`
 * with side effects.
 */
export const server: ServerMutator<Args> = (
    { workspaceId },
    { store, nextVersion }
) => {
    const row = store.getElementTypeAndSlot(workspaceId);
    if (!row) {
        throw new NotFoundError(
            `\`startFresh\` workspace "${workspaceId}" not found`
        );
    }
    if (row.type !== 'workspace' || row.slot !== 'personal_workspace') {
        throw new BadMutationError(
            `\`startFresh\` requires a personal workspace; got type=${row.type} slot=${row.slot}`
        );
    }
    store.archiveEntity({ entityId: workspaceId, version: nextVersion });
};

/**
 * Optimistic local soft-delete on the current workspace's Replicache
 * client. The UI navigates away to the freshly-minted workspace
 * immediately after the push lands, so this is mostly cosmetic — but
 * matches the `archiveList` shape and keeps the entity from briefly
 * re-rendering before pull catches up.
 */
export const client: ClientMutator<Args> = async (
    tx,
    { workspaceId },
    { timestamp_client }
) => {
    const raw = await tx.get(workspaceId);
    if (!raw) return;
    const entity = raw as Record<string, unknown> & { version?: number };
    const ts = timestamp_client ?? new Date();
    await tx.set(
        workspaceId,
        toStoredValue({
            ...entity,
            time_deleted: ts.toISOString(),
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

export const inverse: Inverse<Args> = () => null;
