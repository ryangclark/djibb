import { z } from 'zod';
import { type AuthorizationRole } from '@djibb/protocol/auth/rules';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * ADR 0011 §Step 7: actor removes themselves from an entity's
 * `authorization_rules.authorized_accounts`. The shape mirrors
 * `removeMember` but the target is always `ctx.accountId`, so no
 * `targetAccountId` arg.
 *
 * Special role surface. The mutator's `requiredRole` covers every
 * `AuthorizationRole` because the action is "remove my own grant" —
 * any account with any grant should be able to drop it. The gate that
 * matters is "actor must have a grant on this entity," enforced
 * implicitly by the SQL lookup.
 *
 * Preconditions (server-checked):
 *   - actor must have an entry in `authorized_accounts`.
 *   - actor cannot be the last owner — `transferOwnership` first.
 *   - entity must not be `slot='personal_workspace'` (no escape hatch
 *     from your own workspace; it'd orphan all your contents).
 *
 * Not undoable. Returning `null` from `inverse` keeps "leave" out of
 * the undo history — re-joining requires an invite, not a button.
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "leaveMember";
/**
 * Every role can run this — including `restricted`. See the file-level
 * comment for why the gate is intentionally open.
 */
export declare const requiredRole: readonly AuthorizationRole[];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Not undoable. Re-joining requires an invite — leaving is a one-way
 * step from the actor's perspective. Same posture as `acceptInvitation`
 * and `transferOwnership`.
 */
export declare const inverse: Inverse<Args>;
