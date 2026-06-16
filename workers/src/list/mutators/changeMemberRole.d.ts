import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0011 §Step 7: change a member's role on an entity. Upserts the
 * grant in `authorization_rules.authorized_accounts` — if the target
 * isn't already a member, this acts as a direct add (the primary path
 * is still invite → accept via ADR 0009, but the umbrella mutator
 * collapses "add" and "modify" into a single surface for the inverse
 * of `removeMember` to target).
 *
 * Preconditions (server-checked):
 *   - actor's role must be admin or owner (`requiredRole` gate).
 *   - role argument must be an `AccountRole` (the narrow membership-
 *     legal subset: admin, checker, editor, owner, viewer). The wider
 *     `AuthorizationRoleEnum` includes `ownerless` and `restricted`
 *     which don't belong on a specific account.
 *   - granting `owner` requires the actor to be the current owner —
 *     same gate as `transferOwnership`. Admins cannot mint owners.
 *   - the single-owner invariant must hold post-write. The mutator
 *     enforces this by demoting any existing owner to `admin` if the
 *     target is being promoted to owner (mirrors `transferOwnership`).
 *   - admins cannot touch an existing owner (no demote-the-owner via
 *     this surface; that goes through `transferOwnership`).
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    targetAccountId: z.ZodString;
    role: z.ZodEnum<{
        admin: "admin";
        checker: "checker";
        editor: "editor";
        owner: "owner";
        viewer: "viewer";
    }>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "changeMemberRole";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
/**
 * Inverse: restore the prior role, or remove the target if they weren't
 * a member before. Routes through `changeMemberRole` (self) for the
 * first case and `removeMember` for the second.
 */
export declare const inverse: Inverse<Args>;
