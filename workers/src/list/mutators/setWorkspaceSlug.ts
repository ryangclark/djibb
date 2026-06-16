import { z } from 'zod';

import { NotFoundError } from '@djibb/protocol/errors';
import { WorkspaceEntitySchema } from '@djibb/protocol/list';
import { OWNER_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * ADR 0011 §Step 7b.5: claim or change a workspace's URL slug. Slug
 * uniqueness is a cross-DO invariant — a single workspace DO can't
 * see other workspaces' slugs — so the actual write happens in an
 * in-DO async preflight (`PREFLIGHTED_MUTATORS` in
 * `durable_object.ts`) that runs an atomic guarded UPDATE against the
 * D1 `UNIQUE(type, slug)` index BEFORE this synchronous mutator
 * fires. By the time `server` runs, the D1 slug is already swapped
 * in or the mutation was skip-and-ack'd with a structured outcome.
 *
 * This mutator's job is just to bump version + time_updated on the
 * workspace's DO entity row so the post-commit snapshot emit fires
 * and refreshes the rest of the catalog projection (time_updated,
 * etc). The slug column on the catalog is deliberately excluded from
 * the snapshot's ON CONFLICT UPDATE clause (see
 * `EmitEntitySnapshotToCatalog`), so a stale alarm-driven re-emit
 * can never clobber a freshly-claimed slug.
 *
 * Admin-or-owner gated, matching `renameWorkspace` and
 * `setWorkspaceImage`.
 */
export const argsSchema = z.object({
    workspaceId: WorkspaceEntitySchema.shape.id,
    /**
     * The slug to claim. Pattern + reserved-set validation lives in
     * the preflight (`workers/src/list/slug.ts::tryClaimSlug`); we
     * accept any non-empty string here so the parse boundary stays
     * lenient and the preflight gets to surface the precise
     * structured `slug_invalid` / `slug_reserved` / `slug_taken`
     * outcome reason.
     */
    slug: z.string().min(1).max(40),
    /**
     * Narrow set-family CAS pre-check. When present, the server
     * compares the current slug to `expected.slug`; mismatch is
     * silently a no-op. Forward calls don't supply `expected`;
     * undo / redo do. ADR 0005 §"Defensive conflict policy."
     *
     * The slug isn't readable from the DO's SQL (slug lives D1-side
     * only; the DO entity row has no slug column), so the CAS check
     * actually happens in the preflight: when `expected` is set, the
     * preflight reads the current D1 slug and compares before
     * attempting the claim. Here we just pass the field through.
     */
    expected: z
        .object({
            slug: z.string(),
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setWorkspaceSlug' as const;
export const requiredRole = OWNER_ROLES;

export const server: ServerMutator<Args> = (
    { workspaceId },
    { store, nextVersion },
) => {
    // The preflight ran the actual D1 slug claim. All we do here is
    // bump version + time_updated on the DO entity row so the
    // post-commit `emitEntitySnapshot()` upserts a refreshed catalog
    // row. `bumpWorkspaceVersion()` is type-narrowed to workspace
    // rows; a misrouted call against a list/template id throws
    // `NotFoundError` (which the dispatcher converts to a skip-and-
    // ack — defensive, not security-critical).
    store.bumpWorkspaceVersion({ workspaceId, version: nextVersion });
};

export const client: ClientMutator<Args> = async (
    tx,
    { workspaceId, slug, expected },
    { timestamp_client },
) => {
    const raw = await tx.get(workspaceId);
    if (!raw) {
        throw new NotFoundError(`workspace "${workspaceId}" not found`);
    }
    const entity = raw as Record<string, unknown> & {
        version?: number;
        slug?: string;
    };

    // Optimistic CAS: if the caller specified an expected slug and
    // the local cache disagrees, no-op locally. The server's
    // preflight does its own CAS read against D1.
    if (expected !== undefined && entity.slug !== undefined &&
        entity.slug !== expected.slug) {
        return;
    }

    const ts = timestamp_client ?? new Date();
    await tx.set(
        workspaceId,
        toStoredValue({
            ...entity,
            // Optimistic local update so any UI binding the workspace
            // row's slug renders the new value immediately. If the
            // server preflight skips with `slug_taken`, Replicache
            // will rebase the client back to the server state on the
            // next pull and the cached value reverts.
            slug,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        }),
    );
};

export const capturePreState: CapturePreState<Args> = async (
    tx,
    { workspaceId },
) => {
    const raw = await tx.get(workspaceId);
    if (!raw) return {};
    const entity = raw as Record<string, unknown>;
    return { slug: entity.slug };
};

/**
 * Set-family inverse: restore the prior slug with a CAS guard on the
 * post-state value. Returns `null` when there's no prior slug
 * captured (first-claim mid-session before the schema landed) — the
 * action just doesn't enter the undo history.
 */
export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || preState.slug === undefined) return null;
    return {
        name,
        args: {
            workspaceId: args.workspaceId,
            slug: preState.slug as string,
            expected: { slug: args.slug },
        },
    };
};
