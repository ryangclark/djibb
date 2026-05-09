import { z } from 'zod';
import type {
    MutatorReturn,
    ReadonlyJSONObject,
    WriteTransaction,
} from 'replicache';

import { AuthorizationRoleEnum } from '../../auth/rules';
import type { AuthorizationRole } from '../../auth/rules';
import { DatelikeToDateSchema } from '../../schema';

/**
 * Roles permitted to mutate list state. Anonymous (`ownerless`) lists
 * remain editable; explicit `viewer` and `restricted` cannot mutate.
 */
export const EDIT_ROLES: readonly AuthorizationRole[] = [
    AuthorizationRoleEnum.enum.admin,
    AuthorizationRoleEnum.enum.checker,
    AuthorizationRoleEnum.enum.editor,
    AuthorizationRoleEnum.enum.owner,
    AuthorizationRoleEnum.enum.ownerless,
] as const;

/**
 * Roles permitted to change who can access the list. Tighter than
 * `EDIT_ROLES` — an editor or checker can mutate list state, but only
 * an admin or owner can re-grant access. `ownerless` is intentionally
 * excluded: an anonymous-edit list cannot be locked down by a passing
 * stranger; the path to claim ownership of an ownerless list goes
 * through a separate (yet-unbuilt) "claim" flow rather than a generic
 * auth-rules mutation.
 */
export const OWNER_ROLES: readonly AuthorizationRole[] = [
    AuthorizationRoleEnum.enum.admin,
    AuthorizationRoleEnum.enum.owner,
] as const;

/**
 * Wire-level envelope fields carried alongside every mutation's body
 * args. Replicache forces our metadata into `args`, so on the wire
 * `accountId` and `timestamp_client` ride inside `args`. Dispatch
 * extracts them at parse time and presents them to mutators via ctx.
 */
export const MutationEnvelopeArgsSchema = z.object({
    accountId: z.string().nullable(),
    timestamp_client: DatelikeToDateSchema.nullable(),
});

export type MutationEnvelopeArgs = z.infer<typeof MutationEnvelopeArgsSchema>;

/** Context passed to every server mutator after dispatch validation. */
export type ServerMutatorCtx = {
    sql: SqlStorage;
    role: AuthorizationRole;
    accountId: string | null;
    timestamp_client: Date | null;
    nextVersion: number;
};

/** Context passed to every client mutator (Replicache transaction). */
export type ClientMutatorCtx = {
    accountId: string | null;
    timestamp_client: Date | null;
};

export type ServerMutator<A> = (args: A, ctx: ServerMutatorCtx) => void;
export type ClientMutator<A> = (
    tx: WriteTransaction,
    args: A,
    ctx: ClientMutatorCtx
) => MutatorReturn;

/** Replicache values must be plain JSON; round-trip strips Date instances. */
export function toStoredValue(value: unknown): ReadonlyJSONObject {
    return JSON.parse(JSON.stringify(value));
}
