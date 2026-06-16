import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0011 §Step 5: mint a new Workspace as a DjibbList-substrate
 * entity. The caller becomes the sole owner; `default_role` is
 * `restricted` (workspace contents are private by default — sharing
 * comes via per-account grants in `authorized_accounts`, the same
 * machinery that gates lists and templates).
 *
 * Symmetric to `initList` but for `type: 'workspace'`. The DO that
 * receives the push is addressed by the workspace's own ID
 * (`w/<suffix>` prefix). `workspace_id` on the entity row is `null` —
 * a workspace is not nested under another workspace.
 *
 * `slot` is left null here. The `personal_workspace` slot is the
 * concern of step 6's signup flow; ordinary `createWorkspace` mints
 * a team workspace with no slot assignment.
 *
 * **Slug** defaults to the workspace ID's suffix (the nanoid that
 * already lives after the `w/` prefix). The default needs no UNIQUE
 * arbitration — the suffix is a fresh nanoid and cannot collide with
 * an existing workspace. User-customized slugs ride on top via
 * `setWorkspaceSlug`, which runs an in-DO preflight against the D1
 * `UNIQUE(type, slug)` index before its synchronous mutator commits
 * (ADR 0011 §Step 7b.5).
 */
export declare const argsSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    name: z.ZodString;
    slot: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        personal_workspace: "personal_workspace";
        inbox: "inbox";
        seed_pool: "seed_pool";
    }>>>;
}, z.core.$strip>;
/**
 * Wire shape: as it arrives in a Replicache mutation, including
 * envelope metadata. Mirrors `initList`'s wireArgsSchema pattern.
 */
export declare const wireArgsSchema: z.ZodObject<{
    accountId: z.ZodNullable<z.ZodString>;
    timestamp_client: z.ZodNullable<z.ZodPipe<z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodDate]>, z.ZodCoercedDate<string | number | Date>>>;
    workspaceId: z.ZodString;
    name: z.ZodString;
    slot: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        personal_workspace: "personal_workspace";
        inbox: "inbox";
        seed_pool: "seed_pool";
    }>>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export type WireArgs = z.infer<typeof wireArgsSchema>;
export declare const name: "createWorkspace";
/**
 * Permissive on purpose, same as `initList`: a fresh DO has no
 * `authorized_accounts`, so the caller's role resolves to
 * `ownerless`. Without `ownerless` in the gate, a workspace could
 * never be born.
 */
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Constructive inverse: undoing a workspace creation archives it.
 * Friction-tier per ADR 0005 — workspace creation crosses a far
 * larger structural threshold than list creation; the runtime
 * should render a confirm toast on Cmd+Z. (Workspace mutators are
 * not yet listed in `FRICTION_TIER_MUTATORS`; revisit when the UI
 * surface lands in step 9.)
 *
 * Returns `null` for now — `archiveWorkspace` is not implemented
 * yet (the workspace cascade-delete dispatcher is step 10 of
 * ADR 0011). Once that lands, swap the body to
 * `{ name: 'archiveWorkspace', args: { workspaceId } }`.
 */
export declare const inverse: Inverse<Args>;
