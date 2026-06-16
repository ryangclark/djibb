import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0011 §Decision C — atomically transfer the entity's principal
 * `'owner'` role to another account. The current owner becomes
 * `'admin'` (same powers, no longer the unique principal); the target
 * becomes `'owner'`. The swap preserves the single-owner invariant.
 *
 * Caller authorization: the role gate requires `'owner'`, but that
 * isn't strict enough on its own — an entity with multiple admins
 * would all pass. The server mutator additionally checks that
 * `ctx.accountId` matches the current owner; a mismatch surfaces
 * `{status: 'stale'}` so the runtime treats it like a CAS conflict
 * (someone else transferred first, or the caller's local state was
 * out of date).
 *
 * Recipient authorization: the target must already be an authorized
 * member of the entity (`{status: 'gone'}` otherwise). Because the
 * transfer is immediate and non-consensual, restricting it to existing
 * members is what keeps it from being an unwanted-ownership /
 * notification-spam vector — see the server mutator's guard.
 *
 * Not undoable. Returning `null` from `inverse` keeps the action out
 * of the undo history entirely. Reversal happens out-of-band: the new
 * owner can transfer back. Adding it to `FRICTION_TIER_MUTATORS` would
 * be the natural next move once the undo runtime supports friction
 * confirms without a paired inverse.
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    toAccountId: z.ZodString;
    fromAccountId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "transferOwnership";
/**
 * Only an `'owner'` can transfer. `'admin'` is intentionally excluded:
 * the principal role is the one the transfer mints, and we don't want
 * a non-principal admin to be able to redirect ownership.
 */
export declare const requiredRole: readonly ["owner"];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Not undoable. Reversal is "the new owner transfers back," which
 * requires their participation and so doesn't belong in the original
 * caller's undo stack. See header comment.
 */
export declare const inverse: Inverse<Args>;
