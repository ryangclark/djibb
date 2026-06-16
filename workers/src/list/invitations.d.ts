import { z } from 'zod';
import { type AccountRole, type AuthorizationRules } from '@djibb/protocol/auth/rules';
import type { Account } from '@djibb/protocol/account';
/**
 * ADR 0009: tokenless DO-resident invitations.
 *
 * This module owns three concerns:
 *
 *   1. The DO-side `pending_invites` SQL table — authoritative storage
 *      for pending invitations on a single entity (this DO's List or
 *      Template). Hard-deleted on revoke/accept; the D1 audit row
 *      retains the history.
 *
 *   2. The D1 `entity_invitations_index` projection — derived, emitted
 *      post-commit per the ADR 0003 pattern. Powers the "what's
 *      pending for me?" inbox and cross-target per-inviter rate
 *      limits.
 *
 *   3. The post-commit reconciler (`EmitInvitationsSnapshot`) — runs
 *      from `durable_object.ts` after any invitation-touching push.
 *      UPSERTs DO rows as `status='pending'`; marks any D1 pending
 *      rows for this target that are no longer present in the DO as
 *      `status='revoked'`. Acceptance is its own emit (future slice)
 *      so the reconciler doesn't downgrade an accept to revoked.
 *
 * v1 only implements `identity_kind = 'email'`. The schema is
 * identity-kind-agnostic so `username` / `account_id` slot in as data,
 * not migrations.
 */
export declare const InvitationIdentityKindEnum: z.ZodEnum<{
    email: "email";
}>;
export type InvitationIdentityKind = z.infer<typeof InvitationIdentityKindEnum>;
export declare const InvitationStatusEnum: z.ZodEnum<{
    pending: "pending";
    accepted: "accepted";
    revoked: "revoked";
    expired: "expired";
}>;
export type InvitationStatus = z.infer<typeof InvitationStatusEnum>;
/**
 * Default invitation lifetime — 7 days, per ADR 0009 §"Other policy
 * defaults." Lazy-expire on read (no cron); the index keeps the row
 * until cascade-delete or audit prune.
 */
export declare const INVITATION_TTL_MS: number;
/**
 * Normalize an identity value for storage and lookup. Email is
 * lower-cased; everything else passes through unchanged. The DO and D1
 * index both index by the normalized form so case-mismatched lookups
 * resolve cleanly.
 */
export declare function normalizeIdentityValue(kind: InvitationIdentityKind, value: string): string;
/**
 * Create the `pending_invites` table inside the DO's SQL storage.
 * Idempotent — `IF NOT EXISTS` is safe to run on every constructor
 * pass, which is the migration story for DOs that came up before
 * ADR 0009 landed.
 *
 * The DO is single-tenant for one entity; (identity_kind,
 * identity_value) is sufficient as the primary key. There is no
 * `target_id` column — every row here is for this DO's entity.
 *
 * `version` is bumped to the entity's `nextVersion` on insert and
 * cleared on delete; the pull handler (Slice 2) uses it to surface
 * invite changes through Replicache's diffing.
 */
export declare function ensurePendingInvitesTable(sql: SqlStorage): void;
export type PendingInviteRow = {
    identity_kind: InvitationIdentityKind;
    identity_value: string;
    role: AccountRole;
    inviter_account_id: string;
    time_created: number;
    time_expires: number;
    time_deleted: number | null;
    version: number;
};
/**
 * Read one live (non-tombstoned) pending invite by
 * (identity_kind, identity_value). Returns null when no row exists or
 * the row has been revoked (tombstoned).
 */
export declare function getPendingInvite(sql: SqlStorage, { identity_kind, identity_value, }: {
    identity_kind: InvitationIdentityKind;
    identity_value: string;
}): PendingInviteRow | null;
/**
 * List all live pending invites in this DO. Tombstones are filtered
 * out — they survive in storage only so the pull keyspace can emit
 * `op:'del'` to demoted/recently-cached clients.
 */
export declare function listPendingInvites(sql: SqlStorage): PendingInviteRow[];
/**
 * Read all invite rows (live + tombstoned) whose `version` is greater
 * than the supplied threshold. Used by the pull keyspace
 * (`pending_invites`) — live rows become `put` ops; tombstones become
 * `del` ops.
 */
export declare function getChangedInvitesSinceVersion(sql: SqlStorage, prevVersion: number): PendingInviteRow[];
/**
 * Every live invite's Replicache key (`pending_invites/<identity>`).
 * Used by the pull-filter demotion path: when an owner is demoted,
 * their next pull emits `op:'del'` for each of these so Replicache
 * evicts the cached keyspace.
 */
export declare function listAllCurrentInviteKeys(sql: SqlStorage): string[];
/**
 * Insert (or revive) a pending invite. The DO's (kind, value) row is
 * unique by PRIMARY KEY, but a previously-tombstoned row can be
 * re-invited — the natural shape is an UPSERT that clears
 * `time_deleted` and refreshes the live fields. Throws if the caller
 * tries to re-insert atop a *live* row; check `getPendingInvite`
 * first when idempotent semantics are required.
 */
export declare function insertPendingInvite(sql: SqlStorage, row: PendingInviteRow): void;
/**
 * Soft-delete (tombstone) a pending invite. Sets `time_deleted` and
 * bumps `version` so the next pull diff surfaces the change as an
 * `op:'del'` to clients that had previously cached the row. Returns
 * true if a live row was tombstoned; false if no live row existed.
 */
export declare function tombstonePendingInvite(sql: SqlStorage, { identity_kind, identity_value, nowSeconds, version, }: {
    identity_kind: InvitationIdentityKind;
    identity_value: string;
    nowSeconds: number;
    version: number;
}): boolean;
export type InvitationSnapshot = {
    target_id: string;
    target_type: 'list' | 'template';
    identity_kind: InvitationIdentityKind;
    identity_value: string;
    role: AccountRole;
    inviter_account_id: string;
    time_created: number;
    time_expires: number;
};
/**
 * Reconcile the D1 `entity_invitations_index` against the DO's current
 * `pending_invites` table for a single target entity.
 *
 *   - DO rows are UPSERTed into D1 as `status='pending'` (creating new
 *     index rows where needed; refreshing role/expiry on existing
 *     pending rows).
 *   - D1 pending rows whose (identity_kind, identity_value) is NOT in
 *     the DO snapshot are marked `status='revoked'`. This is how
 *     revoke surfaces to the index without a separate emit path.
 *
 * Acceptance flips a row to `status='accepted'` via a direct emit
 * (future slice) before this reconciler runs, so the "missing in DO ⇒
 * revoked" rule must only consider rows currently `status='pending'`.
 *
 * Per ADR 0003 the DO is authoritative; this emit is best-effort. The
 * push-path caller logs and moves on; the alarm-driven reconciliation
 * (ADR 0007) is the eventual repair path for persistent drift.
 */
export declare function EmitInvitationsSnapshot(d1: D1Database, { targetId, targetType, doInvites, newIdForRow, }: {
    targetId: string;
    targetType: 'list' | 'template' | 'workspace';
    doInvites: readonly PendingInviteRow[];
    /**
     * Caller-supplied ID minter for fresh index rows. Injected so
     * this module doesn't depend on the id module's nanoid (which
     * keeps it pure for testing).
     */
    newIdForRow: () => string;
}): Promise<void>;
/**
 * Count invitations created by a single account within a sliding
 * window. Used by the per-inviter rate limit (default 10/hour;
 * ADR 0009 §"Other policy defaults"). Status-agnostic — abuse vector
 * is "how many email sends triggered" not "how many are outstanding."
 *
 * Caller passes `sinceMs` as a unix-seconds threshold (e.g. now - 3600).
 */
export declare function CountInvitesByInviterSince(d1: D1Database, inviterAccountId: string, sinceSeconds: number): Promise<number>;
/**
 * Count an inviter's currently outstanding (pending) invitations
 * across all targets. Default cap 25 per ADR 0009.
 */
export declare function CountOutstandingInvitesByInviter(d1: D1Database, inviterAccountId: string): Promise<number>;
/**
 * Hard-delete all index rows for a target entity. Hook for the
 * cascade-delete path (ADR 0008) when a List/Template DO is torn down.
 * Wired in a follow-up slice; exported now so the substrate is
 * complete.
 */
/**
 * Per-inviter outstanding-invite cap across all entities. The cap is
 * enforced at the HTTP `/push` preflight (Slice 2.5); the DO doesn't
 * see request volume across targets, so this gate must live above it.
 * Value mirrors `MAX_OUTSTANDING_PER_INVITER` in the workspace-invite
 * module — ADR 0009 §"Other policy defaults."
 */
export declare const INVITE_MAX_OUTSTANDING_PER_INVITER = 25;
/**
 * Per-inviter rate cap over the last hour. Enforced at the HTTP
 * `/push` preflight against `entity_invitations_index.time_created`
 * (status-agnostic — abuse vector is "how many sends fired", not "how
 * many are still open").
 */
export declare const INVITE_MAX_PER_INVITER_PER_HOUR = 10;
/**
 * Deps for `preflightInviteByIdentity`. Injected as functions rather
 * than passing a raw D1 binding so this stays pure-ish: tests can stub
 * each query, and the `/push` route binds them once against
 * `c.env.DJIBB_AUTH`.
 */
export type InvitePreflightDeps = {
    countInvitesByInviterSince: (inviterAccountId: string, sinceSeconds: number) => Promise<number>;
    countOutstandingInvitesByInviter: (inviterAccountId: string) => Promise<number>;
    /**
     * Resolve a (lower-cased) email to an existing Account. Used for the
     * "already a member" pre-check. Return `null` when no account
     * matches — that's the common case (inviting a non-djibb user), and
     * we still let the invite through.
     */
    getAccountIdByEmail: (normalizedEmail: string) => Promise<string | null>;
};
export type InvitePreflightInput = {
    /** From `mutation.args.accountId`. Null/empty rejects. */
    inviter_account_id: string | null | undefined;
    identity_kind: InvitationIdentityKind;
    identity_value: string;
    /**
     * The entity's current authorization_rules. `null` only when the
     * entity row is missing (pre-init); in that case we reject — invites
     * presuppose an existing target.
     */
    authorization_rules: AuthorizationRules | null;
    /** Account ids on the caller's session. Inviter must be one. */
    sessionAccountIds: readonly string[];
    /** Unix seconds. Injected so tests can pin time. */
    nowSeconds: number;
};
export type InvitePreflightFailureReason = 'unauthenticated_inviter' | 'session_mismatch' | 'entity_missing' | 'rate_limit_hour' | 'outstanding_cap' | 'already_member' | 'self_invite';
export type InvitePreflightResult = {
    ok: true;
} | {
    ok: false;
    reason: InvitePreflightFailureReason;
    message: string;
};
/**
 * Validate an `inviteByIdentity` request before it reaches the DO.
 * Cross-target concerns (rate limit, outstanding cap) and identity
 * resolution (`email -> account`, "already a member") live at this
 * boundary because the DO is single-entity and has no synchronous
 * D1 access during a push.
 *
 * Returns a structured result rather than throwing — the caller maps
 * each reason to the appropriate HTTP status (401 / 412 / 404).
 */
export declare function preflightInviteByIdentity(deps: InvitePreflightDeps, input: InvitePreflightInput): Promise<InvitePreflightResult>;
export declare function DeleteInvitationsForTarget(d1: D1Database, targetId: string): Promise<void>;
export type PendingIndexRow = {
    id: string;
    target_id: string;
    target_type: 'list' | 'template';
    identity_kind: InvitationIdentityKind;
    identity_value: string;
    role: AccountRole;
    inviter_account_id: string;
    status: InvitationStatus;
    time_created: number;
    time_expires: number;
};
/**
 * Look up a single invitation row from the D1 index by
 * (target_id, identity_kind, identity_value). Used by the
 * `acceptInvitation` HTTP preflight so a revoked or never-existed link
 * surfaces as 404 without round-tripping the DO.
 *
 * Returns the row regardless of status — callers decide whether
 * accepted / revoked rows are interesting. v1 only matches against the
 * normalized identity value (callers normalize first).
 */
export declare function GetInvitationFromIndex(d1: D1Database, { targetId, identity_kind, identity_value, }: {
    targetId: string;
    identity_kind: InvitationIdentityKind;
    identity_value: string;
}): Promise<PendingIndexRow | null>;
/**
 * Flip the matching D1 index row from `status='pending'` to
 * `status='accepted'`. Called from the DO push handler's post-commit
 * tail BEFORE `EmitInvitationsSnapshot` runs — otherwise the
 * reconciler's "missing in DO ⇒ revoked" rule would clobber the
 * accept (the DO row was tombstoned by the mutator). No-op if the row
 * isn't currently pending (idempotent under retry).
 */
export declare function MarkInvitationsAccepted(d1: D1Database, targetId: string, accepted: ReadonlyArray<{
    identity_kind: InvitationIdentityKind;
    identity_value: string;
}>): Promise<void>;
export type AcceptPreflightDeps = {
    /**
     * Look up the D1 index row matching the entity + identity. Null
     * when no row matches (link revoked, never created, or wrong
     * entity). Caller is expected to normalize `identity_value` first.
     */
    getInvitationFromIndex: (targetId: string, identity_kind: InvitationIdentityKind, identity_value: string) => Promise<PendingIndexRow | null>;
};
export type AcceptPreflightInput = {
    /** From `mutation.args.accountId`. Null/empty rejects. */
    acceptor_account_id: string | null | undefined;
    target_id: string;
    identity_kind: InvitationIdentityKind;
    identity_value: string;
    /** All accounts on the caller's session. Acceptor must be one. */
    sessionAccounts: ReadonlyArray<Pick<Account, 'id' | 'email' | 'email_verified'>>;
    /** Unix seconds. Injected so tests can pin time. */
    nowSeconds: number;
};
export type AcceptPreflightFailureReason = 'unauthenticated_acceptor' | 'session_mismatch' | 'identity_unverified' | 'invitation_not_found' | 'invitation_expired' | 'invitation_not_pending';
export type AcceptPreflightResult = {
    ok: true;
    /** Normalized identity (lower-cased for email) so the DO mutator
     *  uses the same key the index resolved against. */
    normalized_identity_value: string;
    /** D1 row that resolved — caller can carry the role / inviter
     *  forward into the mutator if a future variant wants them. */
    index_row: PendingIndexRow;
} | {
    ok: false;
    reason: AcceptPreflightFailureReason;
    message: string;
};
/**
 * Validate an `acceptInvitation` request before it reaches the DO.
 *
 * The DO mutator role-gates on the entity's authorization_rules, which
 * for a fresh invitee resolves to `restricted` — that gate would reject
 * the push outright if `acceptInvitation` were treated like any other
 * mutator. So the HTTP `/push` handler exempts accept-only pushes from
 * the `restricted` block and instead enforces identity ownership here:
 *
 *   1. acceptor is signed in (envelope `accountId` present)
 *   2. acceptor is among the session's accounts
 *   3. acceptor's verified identity matches the invitation's identity
 *      (email kind: lower-case match + email_verified = true)
 *   4. a matching D1 index row exists, is `pending`, and hasn't expired
 *
 * The D1 row read is best-effort: if the D1 projection has lagged behind
 * the DO (unusual; post-commit emit is synchronous), an acceptor whose
 * invite is genuinely live could see a transient 404. The mutator's
 * `gone` outcome covers the inverse race (D1 still pending, DO already
 * revoked).
 */
export declare function preflightAcceptInvitation(deps: AcceptPreflightDeps, input: AcceptPreflightInput): Promise<AcceptPreflightResult>;
