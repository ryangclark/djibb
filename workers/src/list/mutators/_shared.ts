import { z } from 'zod';
import type {
    MutatorReturn,
    ReadonlyJSONObject,
    ReadTransaction,
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

/**
 * Outcome a server mutator may surface up the call stack. Per ADR
 * 0005's defensive policy, set-family CAS-stale and target-gone are
 * structured outcomes — not exceptions. Mutators return `void` (or
 * `undefined`) for the implicit `'applied'` case; CAS-aware mutators
 * return the explicit status when their write was a no-op.
 *
 * The runtime's outcome channel (B.1, ADR 0006) maps these onto
 * `MutationOutcomeStatus` for the client's outcome listener (B.2).
 */
export type ServerMutatorOutcome =
    | undefined
    | void
    | { status: 'stale' | 'gone' };

export type ServerMutator<A> = (
    args: A,
    ctx: ServerMutatorCtx
) => ServerMutatorOutcome;
export type ClientMutator<A> = (
    tx: WriteTransaction,
    args: A,
    ctx: ClientMutatorCtx
) => MutatorReturn;

/**
 * Snapshot of fields the inverse will need to restore. Returned by
 * `capturePreState` at forward-fire time and threaded back into
 * `inverse` so it can populate restore values and `expected` (CAS).
 *
 * Per ADR 0005, only set-family mutators export `capturePreState`;
 * constructive and archive/restore mutators don't need pre-state —
 * the inverse is fully determined by the forward args.
 */
export type PreState = Record<string, unknown>;

/**
 * Reads the fields the inverse will need from the Replicache cache,
 * at forward-fire time. Set-family mutators only. Returns an object
 * whose keys exactly match the keys present in `args.fields` (for
 * umbrella shape) or the single field key (for narrow shape).
 *
 * See ADR 0005 §"Pre-state capture" and `docs/adding-a-mutator.md`
 * step 5.
 */
export type CapturePreState<A> = (
    tx: ReadTransaction,
    args: A
) => Promise<PreState>;

/**
 * Picks the inverse mutator and its args for a given forward call.
 * Returns `null` when the action is intentionally not undoable; the
 * runtime treats `null` as a silent skip (the action just doesn't
 * enter the user's undo history).
 *
 *  - Constructive mutators: ignore `preState`; the id is in `args`.
 *  - Archive/restore mutators: ignore `preState`; the pair is the
 *    mirror mutator (`archiveListItem` ↔ `unarchiveListItem`).
 *  - Set-family mutators: read `preState` to populate the restore
 *    fields + `expected` (CAS).
 *
 * Required by ADR 0005 — every mutator declares an inverse. The type
 * is exported from A.0 so subsequent mutator PRs can layer onto it;
 * A.6 makes the export required at compile time across the registry.
 */
export type Inverse<A> = (
    args: A,
    preState?: PreState
) => { name: string; args: unknown } | null;

/**
 * Mutators that warrant a two-step confirm-toast on undo. Crossing
 * either an authority threshold (auth-rules change) or a structural
 * threshold (list creation) lands a mutator on this list. The undo
 * runtime (ADR 0005 §"Friction tiers") consults this when deciding
 * whether to render a plain undo toast or a confirm-prompt variant.
 *
 * Names are wire names. A.0 keeps this informational; B.2 wires the
 * lookup; A.6 will assert every entry is a valid key of `Mutations`.
 */
export const FRICTION_TIER_MUTATORS: readonly string[] = [
    'setListAuthRules',
    'initList',
    'initFromTemplate',
] as const;

export type FrictionTier = 'two-step-confirm';

export function isFrictionTier(name: string): boolean {
    return FRICTION_TIER_MUTATORS.includes(name);
}

/**
 * The full module-level contract every mutator file must export. Used
 * by the `Mutations` registry's `satisfies` clause to enforce the
 * full surface at compile time, including the `inverse` requirement
 * from ADR 0005. Forgetting `inverse` becomes a build error from A.6
 * forward.
 *
 * `capturePreState` stays optional — only set-family mutators need
 * pre-state capture; constructive and archive/restore don't.
 */
export type MutatorModule<A = unknown> = {
    name: string;
    requiredRole: readonly AuthorizationRole[];
    argsSchema: z.ZodType<A>;
    server: ServerMutator<A>;
    client: ClientMutator<A>;
    inverse: Inverse<A>;
    capturePreState?: CapturePreState<A>;
};

/** Replicache values must be plain JSON; round-trip strips Date instances. */
export function toStoredValue(value: unknown): ReadonlyJSONObject {
    return JSON.parse(JSON.stringify(value));
}
