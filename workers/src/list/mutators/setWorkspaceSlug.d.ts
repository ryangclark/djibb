import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
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
export declare const argsSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    slug: z.ZodString;
    expected: z.ZodOptional<z.ZodObject<{
        slug: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "setWorkspaceSlug";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
/**
 * Set-family inverse: restore the prior slug with a CAS guard on the
 * post-state value. Returns `null` when there's no prior slug
 * captured (first-claim mid-session before the schema landed) — the
 * action just doesn't enter the undo history.
 */
export declare const inverse: Inverse<Args>;
