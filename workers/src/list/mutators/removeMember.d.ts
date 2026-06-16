import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0011 §Step 7: admin-initiated removal of a member from an
 * entity's `authorization_rules.authorized_accounts`. Symmetric to the
 * legacy `RemoveMember` HTTP endpoint, but routed through the DO so the
 * authoritative rules JSON and the `entity_memberships` projection stay
 * coherent in one commit.
 *
 * Preconditions (server-checked):
 *   - actor's role must be admin or owner (`requiredRole` gate).
 *   - target must exist in `authorized_accounts`.
 *   - cannot remove the last owner (the single-owner invariant allows
 *     zero owners, but losing the principal silently strips the entity
 *     of any "claim ownership" path; we require an explicit
 *     `transferOwnership` first).
 *   - admins cannot remove owners — the principal-vs-non-principal
 *     distinction lives at this gate, not at the DO sql layer.
 *
 * Constructive shape — no pre-state needed; the prior role is recovered
 * via `capturePreState` so the inverse can restore the exact grant.
 * Not in `FRICTION_TIER_MUTATORS` yet; revisit when the members UI
 * surfaces this action.
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    targetAccountId: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "removeMember";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
/**
 * Inverse: re-add the target with the role they had before removal.
 * Surfaced through `changeMemberRole` (the role-set mutator) — it
 * upserts the grant whether or not it was there before, which is the
 * shape we want here.
 *
 * Returns `null` when the target wasn't a member at forward-fire time
 * (nothing to undo) or when the rules block has changed shape in a way
 * we can't safely reverse.
 */
export declare const inverse: Inverse<Args>;
