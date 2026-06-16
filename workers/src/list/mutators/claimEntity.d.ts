import { z } from 'zod';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
/**
 * Claim an ownerless entity — the "Adopt" half of the Minted List flow
 * (CONTEXT.md §Minted List). An anonymous homepage visitor mints a List
 * via `mintFromBlank` (ownerless: empty `authorized_accounts`,
 * `default_role: 'ownerless'`, null `workspace_id`); when they later
 * sign in, this promotes that same entity in place — no content merge,
 * because the minted id never changes. Identity is stable across the
 * auth boundary; only the authorization and workspace move.
 *
 * `transferOwnership` deliberately refuses ownerless entities ("Promotion
 * from ownerless lives in a future 'claim' mutator, not here") — this is
 * that mutator. It is the inverse situation: 0 → 1 owner rather than a
 * 1 → 1 swap.
 *
 * **Authorization is enforced in the body, not the gate.** An authed
 * caller resolves to the entity's `default_role` — `ownerless` — so the
 * role gate is `[ownerless]`. But an *anonymous* caller resolves to
 * `ownerless` too, so the gate alone can't tell them apart: the server
 * additionally requires `accountId` (mirroring `transferOwnership`'s
 * defensive `if (!accountId)` guard).
 *
 * **CAS-guarded.** Reading current rules and finding an owner means
 * someone claimed first — surface `{status: 'gone'}` so the runtime
 * treats it like a conflict. A same-account re-claim is an idempotent
 * no-op (the adopt-on-sign-in loop may fire more than once).
 *
 * Not undoable (`inverse → null`): "disown" is an out-of-band action,
 * like `transferOwnership`'s reversal. Stays off `FRICTION_TIER_MUTATORS`
 * for the same reason (that set needs a paired inverse).
 *
 * NOTE: this changes `authorization_rules` *and* `workspace_id`, both
 * projected to the D1 read index, so `'claimEntity'` MUST be in the DO's
 * `ENTITY_METADATA_MUTATORS` — otherwise the post-commit snapshot never
 * emits and the next pull 404s (the bug `mintFromBlank` hit).
 */
export declare const argsSchema: z.ZodObject<{
    listId: z.ZodString;
    workspaceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export type Args = z.infer<typeof argsSchema>;
export declare const name: "claimEntity";
/**
 * Only `ownerless` can claim — an entity that already has a principal is
 * claimed via nothing (it's owned). The body's `accountId` check is what
 * separates an authed claimer from an anonymous passer-by, since both
 * resolve to `ownerless` on the entity.
 */
export declare const requiredRole: readonly ["ownerless"];
export declare const server: ServerMutator<Args>;
export declare const client: ClientMutator<Args>;
/**
 * Not undoable. Reversal ("disown" back to ownerless) is an out-of-band
 * action, not something the claimer's undo stack should silently offer —
 * same posture as `transferOwnership`.
 */
export declare const inverse: Inverse<Args>;
