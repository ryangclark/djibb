import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0009 — create a pending invitation on an entity's
 * `pending_invites` table. The invitation is identified by
 * `(identity_kind, identity_value)`; v1 only supports `email`. No
 * bearer token is generated — recipient is matched on verified
 * identity at accept time.
 *
 * Owner-gated (mirrors `setListAuthRules`'s `requiredRole`); a passing
 * stranger on an ownerless list cannot invite collaborators.
 *
 * `role` is an `InvitableRole` (`AccountRole` minus `owner`): ownership
 * is transferred via `transferOwnership`, never invited. This also
 * stops an `admin` — who passes the `OWNER_ROLES` gate — from minting a
 * second `owner` through the invite path, which `changeMemberRole`
 * already forbids on the direct-grant path.
 *
 * The mutator is constructive — inverse is `revokeInvitation` with the
 * same (kind, value). No pre-state needed; the identity is in the
 * forward args.
 *
 * "Already a member" pre-check is intentionally deferred. The DO
 * cannot map `email -> account_id` synchronously (the lookup is in
 * D1); the check belongs at the HTTP push handler or a future
 * pre-flight slice. Lacking the check, the invite is created and
 * `acceptInvitation` (future slice) will surface the no-op if the
 * invitee turns out to already be a member.
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    identity_kind: z.ZodEnum<{
        email: "email";
    }>;
    identity_value: z.ZodString;
    role: z.ZodEnum<{
        admin: "admin";
        checker: "checker";
        editor: "editor";
        viewer: "viewer";
    }>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "inviteByIdentity";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const inverse: Inverse<Args>;
