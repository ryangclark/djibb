import { z } from 'zod';
import type { CapturePreState, ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0009 — revoke a pending invitation. Hard-deletes from the DO's
 * `pending_invites`; the post-commit reconciler marks the
 * corresponding D1 index row `status='revoked'` (audit retained).
 *
 * Set-family-ish: the inverse is `inviteByIdentity` with the
 * pre-revoke role and inviter restored. `capturePreState` reads from
 * the Replicache cache so undo can repopulate those fields.
 *
 * The Revoke verb is distinct from `setListAuthRules`'s "Remove
 * access" — Revoke acts on a pending invitation; Remove acts on an
 * accepted membership. ADR 0009 §"Verbs: Revoke vs Remove."
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    identity_kind: z.ZodEnum<{
        email: "email";
    }>;
    identity_value: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "revokeInvitation";
export declare const requiredRole: readonly ("admin" | "checker" | "editor" | "owner" | "ownerless" | "restricted" | "viewer" | "system")[];
/**
 * Pre-state for undo: the role, inviter, and expiry from the
 * pre-revoke row. The forward call doesn't carry these — they live on
 * the DO row — so the inverse needs the cache snapshot to reconstruct
 * a fresh invite. `time_created` is intentionally NOT captured —
 * re-invite resets the clock; preserving the original would let
 * undone-revokes expire instantly.
 */
export type RevokePreState = {
    role?: string;
    inviter_account_id?: string;
};
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
export declare const capturePreState: CapturePreState<Args>;
export declare const inverse: Inverse<Args>;
