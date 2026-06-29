import { z } from 'zod';
import type {
    MutatorReturn,
    ReadonlyJSONObject,
    ReadTransaction,
    WriteTransaction,
} from 'replicache';

import { AuthorizationRoleEnum } from '@djibb/protocol/auth/rules';
import type { AuthorizationRole, AuthorizationRules } from '@djibb/protocol/auth/rules';
import { UnexpectedError } from '@djibb/protocol/errors';
import { DatelikeToDateSchema } from '@djibb/protocol/schema';
import type { MutatorStore } from '@djibb/protocol/list/store';

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
 * Roles permitted to *append* to a list — `EDIT_ROLES` plus
 * `submitter` (ADR 0021). `submitter` can add items (`createListItem`)
 * but is intentionally excluded from `EDIT_ROLES`, so every
 * structural/destructive mutator (rename, delete, reorder, set-fields,
 * auth-rules) stays closed to it. Append-only by construction: the only
 * mutator that widens its gate to `APPEND_ROLES` is `createListItem`.
 * Used by the operator-owned Contributed List (`default_role:
 * 'submitter'`) so anonymous `djibb contribute` can append without a
 * token while no passing stranger can vandalize existing contributions.
 */
export const APPEND_ROLES: readonly AuthorizationRole[] = [
    ...EDIT_ROLES,
    AuthorizationRoleEnum.enum.submitter,
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
 * Roles permitted to invoke a system-only mutation — i.e. one driven
 * by another DO inside the cluster rather than by a human session.
 * The only member is `'system'` (ADR 0011 §Step 10a.3 / ADR 0008).
 *
 * The cascade-archive / cascade-restore mutators that land in 10a.4
 * and 10a.5 declare `requiredRole: SYSTEM_ROLES`. Because `'system'`
 * is structurally unreachable from any HTTP-session resolution path
 * (it's not in `AccountRoleEnum`, `DefaultRoleEnum`, or the explicit
 * `authorized_accounts` grant schema), gating on it means the
 * mutator can only fire when the caller of `handlePush` explicitly
 * passed `authorizedRole: 'system'` — which only DO-stub-to-DO-stub
 * RPC can do. Even a workspace owner cannot forge a cascade.
 */
export const SYSTEM_ROLES: readonly AuthorizationRole[] = [
    AuthorizationRoleEnum.enum.system,
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
    /**
     * The mutator storage port (ADR 0014, `MutatorStore`) — every
     * storage read/write a mutator needs goes through here. No raw
     * `SqlStorage` on the ctx: that is what keeps this type (and the
     * whole mutator registry) free of Cloudflare types so it can live
     * in `@djibb/protocol`. The backend's full `EntityStore` is a
     * structural superset, handed in at the DO call site.
     */
    store: MutatorStore;
    role: AuthorizationRole;
    accountId: string | null;
    timestamp_client: Date | null;
    nextVersion: number;
    /**
     * The caller is the platform operator (`OPERATOR_ACCOUNT_ID`). Computed
     * at the DO dispatch site, where `env` is reachable, as
     * `envelope.accountId === OPERATOR_ACCOUNT_ID`. Trustworthy because the
     * cross-account check (durable_object.ts) has already verified
     * `envelope.accountId` belongs to the session before dispatch — only
     * the operator's session can produce a true here. Mutators consult it
     * to gate privileged-only writes (e.g. `initList`'s `slot`/
     * `defaultRole`).
     */
    isOperator: boolean;
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
    'mintFromBlank',
    'transferOwnership',
] as const;

export type FrictionTier = 'two-step-confirm';

export function isFrictionTier(name: string): boolean {
    return FRICTION_TIER_MUTATORS.includes(name);
}

/**
 * Mutators that are genuinely *irreversible* — they sit **outside** the
 * inverse-required undo path (ADR 0005) rather than declaring a real
 * inverse. ADR 0023 §4 / issue #17: this turns "destructive =
 * recoverable" from a review convention into a structural property. An
 * ordinary mutator still cannot ship without an `inverse` (the
 * `MutatorModule` contract makes a missing `inverse` a compile error);
 * a genuinely-terminal op must be *explicitly* listed here, making the
 * opt-out auditable in one place instead of hiding behind a quiet
 * `inverse: () => null`.
 *
 * Membership has a second consequence enforced at dispatch (ADR 0023
 * §4): a terminal mutator is not reachable by a non-interactive client
 * (one acting through an issued bearer credential) until step-up auth
 * ships. `transferOwnership` is terminal *and* non-consensual, so an
 * unattended token must not be able to fire it with no human in the
 * loop and no undo. The DO's `handleMutation` rejects a terminal
 * mutator whenever an acting credential id is present.
 *
 * Names are wire names; every entry must be a valid key of `Mutations`
 * (asserted by `terminalMarker.test.ts`). Other genuinely-terminal
 * operations — hard-purge and cascade hard-delete (ADR 0008) — are
 * *not* registry mutators (they run on the Workspace DO alarm), so they
 * are terminal-by-construction at that layer and intentionally absent
 * from this registry-scoped set.
 */
export const TERMINAL_MUTATORS: readonly string[] = [
    'transferOwnership',
] as const;

export function isTerminal(name: string): boolean {
    return TERMINAL_MUTATORS.includes(name);
}

/**
 * Mutators whose rapid same-target repeats should coalesce into a
 * single undo entry. ADR 0005 §"Reorder coalescing": dragging an
 * item from row 0 → row 2 → row 5 inside the 500ms window is one
 * undo gesture, not three.
 *
 * Set membership alone doesn't define the merge rule — that's
 * mutator-specific. The current set is reorder-only; both reorder
 * mutators share the same merge rule (preserve original `toIndex` of
 * the inverse, refresh `expected.fromIndex` from the latest
 * forward). If a new coalescing candidate emerges with a different
 * shape, the merge rule needs to fork.
 */
export const COALESCING_MUTATORS: readonly string[] = [
    'reorderListItem',
    'reorderListGroup',
] as const;

/** Window in milliseconds within which same-target repeats coalesce. */
export const COALESCE_WINDOW_MS = 500;

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

/**
 * Read a stored `authorization_rules` SQL value as rules. The column is
 * JSON-TEXT at rest, so a non-string is structurally impossible — surface
 * that loudly instead of casting an arbitrary blob into the rules shape (it
 * also lets the callers drop the old `as unknown as AuthorizationRules`).
 */
export function parseStoredAuthorizationRules(raw: unknown): AuthorizationRules {
    if (typeof raw !== 'string') {
        throw new UnexpectedError('authorization_rules not stored as JSON text');
    }
    return JSON.parse(raw);
}

// ---------- Single-owner invariant (ADR 0011 §Decision C) ----------

/**
 * Every entity has at most one principal owner. The `'owner'` role is
 * the unique-per-entity transferable principal; non-principal
 * collaborators with the same powers go through the `'admin'` role.
 * Ownerless entities (`default_role: 'ownerless'`) carry zero owners.
 *
 * Enforcing the invariant in one place lets every rules-writing path
 * (`setListAuthRules`, `acceptInvitation`, `transferOwnership`, and any
 * future grant mutator) share the same gate.
 */

/**
 * Count the accounts holding `role: 'owner'` in a rules block. Used by
 * the single-owner invariant guard and by `transferOwnership`'s
 * "current owner" lookup.
 */
export function countOwners(rules: AuthorizationRules): number {
    let n = 0;
    for (const a of Object.values(rules.authorized_accounts)) {
        if (a.role === 'owner') n += 1;
    }
    return n;
}

/**
 * Return the account ID currently holding `'owner'` in `rules`, or
 * `null` if the entity is ownerless. Throws when the invariant is
 * already violated — that state should be impossible because every
 * rules-writing path runs through `assertSingleOwner`.
 */
export function findOwnerAccountId(
    rules: AuthorizationRules
): string | null {
    let owner: string | null = null;
    for (const [accountId, a] of Object.entries(rules.authorized_accounts)) {
        if (a.role !== 'owner') continue;
        if (owner !== null) {
            throw new SingleOwnerInvariantError(
                `multiple owners on entity rules (at least "${owner}" and "${accountId}")`
            );
        }
        owner = accountId;
    }
    return owner;
}

/**
 * Throw if `rules` would have two or more `'owner'` accounts. Use this
 * at the top of every server mutator that writes `authorization_rules`.
 * Pure check on the post-image — does not consult the DO sql.
 *
 * Zero owners is valid: an entity can be ownerless (`default_role:
 * 'ownerless'`) or admin-managed before a principal is ever assigned.
 * The "exactly-one" version is the post-principal shape; the
 * "at-most-one" check is the broader invariant the system upholds.
 */
export function assertSingleOwner(rules: AuthorizationRules): void {
    const n = countOwners(rules);
    if (n > 1) {
        throw new SingleOwnerInvariantError(
            `single-owner invariant: rules would set ${n} owners`
        );
    }
}

/**
 * Thrown when a mutation would violate the single-owner invariant.
 * Inherits from `Error` rather than `DjibbError` (one of the catalog
 * codes in `workers/src/errors.ts`) so existing dispatch surfaces it
 * as an unhandled failure — the UI never offers a way to construct
 * invalid rules, so this firing is always a bug to fix in the caller.
 */
export class SingleOwnerInvariantError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SingleOwnerInvariantError';
    }
}
