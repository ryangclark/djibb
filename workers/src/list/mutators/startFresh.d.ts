import { z } from 'zod';
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
export declare const argsSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    accountDisplayName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "startFresh";
/**
 * Personal workspaces have exactly one owner (the account that the
 * workspace was minted for at signup). Anyone else would resolve as
 * `restricted`/non-member; only the personal owner can call this.
 */
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
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
export declare const server: ServerMutator<Args>;
/**
 * Optimistic local soft-delete on the current workspace's Replicache
 * client. The UI navigates away to the freshly-minted workspace
 * immediately after the push lands, so this is mostly cosmetic — but
 * matches the `archiveList` shape and keeps the entity from briefly
 * re-rendering before pull catches up.
 */
export declare const client: ClientMutator<Args>;
export declare const inverse: Inverse<Args>;
