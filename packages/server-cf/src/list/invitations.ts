import { z } from 'zod';

import {
    AccountRoleEnum,
    type AccountRole,
    type AuthorizationRules,
} from '@djibb/protocol/auth/rules';
import type { Account } from '@djibb/protocol/account';
import { UnexpectedError } from '@djibb/protocol/errors';
import {
    INVITATION_TTL_MS,
    InvitationIdentityKindEnum,
    InvitationStatusEnum,
    PendingInviteRowSchema,
    normalizeIdentityValue,
    type InvitationIdentityKind,
    type InvitationStatus,
    type PendingInviteRow,
} from '@djibb/protocol/list/invitations';

// Re-export the pure invitation protocol so existing
// `from '../invitations'` importers in this package keep resolving while
// the SQL/D1 helpers below stay backend-resident (ADR 0014).
export {
    INVITATION_TTL_MS,
    InvitationIdentityKindEnum,
    InvitationStatusEnum,
    PendingInviteRowSchema,
    normalizeIdentityValue,
    type InvitationIdentityKind,
    type InvitationStatus,
    type PendingInviteRow,
};

/**
 * Parse a raw DO row into a `PendingInviteRow`, throwing on malformed
 * data. Stays backend-side (not in `@djibb/protocol`) because it logs
 * via `console`, which the runtime-agnostic protocol package doesn't
 * assume as a global.
 */
function parseInviteRow(raw: unknown): PendingInviteRow {
    const parsed = PendingInviteRowSchema.safeParse(raw);
    if (!parsed.success) {
        console.error('parseInviteRow error:', parsed.error.format(), raw);
        throw new UnexpectedError();
    }
    return parsed.data;
}

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

// ---------- DO-side SQL ----------

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
export function ensurePendingInvitesTable(sql: SqlStorage): void {
    sql.exec(
        `CREATE TABLE IF NOT EXISTS pending_invites (
            "identity_kind" TEXT NOT NULL,
            "identity_value" TEXT NOT NULL,
            "role" TEXT NOT NULL,
            "inviter_account_id" TEXT NOT NULL,
            "time_created" INTEGER NOT NULL,
            "time_expires" INTEGER NOT NULL,
            "time_deleted" INTEGER DEFAULT NULL,
            "version" INTEGER NOT NULL,
            PRIMARY KEY (identity_kind, identity_value)
        );`
    );
    // Forward-migration for ADR 0009 Slice 2: revoke is now soft-delete
    // so the pull keyspace can surface `op:'del'` ops to clients that
    // had previously cached the row. ALTER throws "duplicate column"
    // on tables already at v2 — swallow.
    try {
        sql.exec(
            `ALTER TABLE pending_invites
             ADD COLUMN time_deleted INTEGER DEFAULT NULL;`
        );
    } catch {
        /* column already exists */
    }
}

// Common column projection — includes `time_deleted` so callers can
// distinguish live rows from tombstones.
const INVITE_COLS =
    `identity_kind, identity_value, role, inviter_account_id,
     time_created, time_expires, time_deleted, version`;

/**
 * Read one live (non-tombstoned) pending invite by
 * (identity_kind, identity_value). Returns null when no row exists or
 * the row has been revoked (tombstoned).
 */
export function getPendingInvite(
    sql: SqlStorage,
    {
        identity_kind,
        identity_value,
    }: { identity_kind: InvitationIdentityKind; identity_value: string }
): PendingInviteRow | null {
    const rows = sql
        .exec(
            `SELECT ${INVITE_COLS}
             FROM pending_invites
             WHERE identity_kind = ?
               AND identity_value = ?
               AND time_deleted IS NULL
             LIMIT 1;`,
            identity_kind,
            identity_value
        )
        .toArray();
    if (rows.length === 0) return null;
    return parseInviteRow(rows[0]);
}

/**
 * List all live pending invites in this DO. Tombstones are filtered
 * out — they survive in storage only so the pull keyspace can emit
 * `op:'del'` to demoted/recently-cached clients.
 */
export function listPendingInvites(sql: SqlStorage): PendingInviteRow[] {
    const rows = sql
        .exec(
            `SELECT ${INVITE_COLS}
             FROM pending_invites
             WHERE time_deleted IS NULL;`
        )
        .toArray();
    return rows.map(parseInviteRow);
}

/**
 * Read all invite rows (live + tombstoned) whose `version` is greater
 * than the supplied threshold. Used by the pull keyspace
 * (`pending_invites`) — live rows become `put` ops; tombstones become
 * `del` ops.
 */
export function getChangedInvitesSinceVersion(
    sql: SqlStorage,
    prevVersion: number
): PendingInviteRow[] {
    const rows = sql
        .exec(
            `SELECT ${INVITE_COLS}
             FROM pending_invites
             WHERE version > ?;`,
            prevVersion
        )
        .toArray();
    return rows.map(parseInviteRow);
}

/**
 * Every live invite's Replicache key (`pending_invites/<identity>`).
 * Used by the pull-filter demotion path: when an owner is demoted,
 * their next pull emits `op:'del'` for each of these so Replicache
 * evicts the cached keyspace.
 */
export function listAllCurrentInviteKeys(sql: SqlStorage): string[] {
    const rows = sql
        .exec(
            `SELECT identity_value FROM pending_invites
             WHERE time_deleted IS NULL;`
        )
        .toArray();
    return rows.map(r => `pending_invites/${r.identity_value as string}`);
}

/**
 * Insert (or revive) a pending invite. The DO's (kind, value) row is
 * unique by PRIMARY KEY, but a previously-tombstoned row can be
 * re-invited — the natural shape is an UPSERT that clears
 * `time_deleted` and refreshes the live fields. Throws if the caller
 * tries to re-insert atop a *live* row; check `getPendingInvite`
 * first when idempotent semantics are required.
 */
export function insertPendingInvite(
    sql: SqlStorage,
    row: PendingInviteRow
): void {
    // ON CONFLICT path revives a tombstoned row; we WHERE-guard so a
    // live row's INSERT collision still surfaces (caller checked
    // `getPendingInvite` and we shouldn't be here).
    sql.exec(
        `INSERT INTO pending_invites (
            identity_kind, identity_value, role, inviter_account_id,
            time_created, time_expires, time_deleted, version
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
            role = excluded.role,
            inviter_account_id = excluded.inviter_account_id,
            time_created = excluded.time_created,
            time_expires = excluded.time_expires,
            time_deleted = NULL,
            version = excluded.version
         WHERE pending_invites.time_deleted IS NOT NULL;`,
        row.identity_kind,
        row.identity_value,
        row.role,
        row.inviter_account_id,
        row.time_created,
        row.time_expires,
        row.version
    );
}

/**
 * Soft-delete (tombstone) a pending invite. Sets `time_deleted` and
 * bumps `version` so the next pull diff surfaces the change as an
 * `op:'del'` to clients that had previously cached the row. Returns
 * true if a live row was tombstoned; false if no live row existed.
 */
export function tombstonePendingInvite(
    sql: SqlStorage,
    {
        identity_kind,
        identity_value,
        nowSeconds,
        version,
    }: {
        identity_kind: InvitationIdentityKind;
        identity_value: string;
        nowSeconds: number;
        version: number;
    }
): boolean {
    const cursor = sql.exec(
        `UPDATE pending_invites
         SET time_deleted = ?, version = ?
         WHERE identity_kind = ?
           AND identity_value = ?
           AND time_deleted IS NULL;`,
        nowSeconds,
        version,
        identity_kind,
        identity_value
    );
    return cursor.rowsWritten > 0;
}

// ---------- D1 projection ----------

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
export async function EmitInvitationsSnapshot(
    d1: D1Database,
    {
        targetId,
        targetType,
        doInvites,
        newIdForRow,
    }: {
        targetId: string;
        targetType: 'list' | 'template' | 'workspace';
        doInvites: readonly PendingInviteRow[];
        /**
         * Caller-supplied ID minter for fresh index rows. Injected so
         * this module doesn't depend on the id module's nanoid (which
         * keeps it pure for testing).
         */
        newIdForRow: () => string;
    }
): Promise<void> {
    // Map DO rows by (kind, value) for set-difference.
    const doKey = (k: string, v: string) => `${k} ${v}`;
    const doRowsByKey = new Map<string, PendingInviteRow>();
    for (const row of doInvites) {
        doRowsByKey.set(doKey(row.identity_kind, row.identity_value), row);
    }

    // Read current D1 pending rows for this target.
    const existing = await d1
        .prepare(
            `SELECT id, identity_kind, identity_value
             FROM entity_invitations_index
             WHERE target_id = ? AND status = 'pending'`
        )
        .bind(targetId)
        .all<{
            id: string;
            identity_kind: string;
            identity_value: string;
        }>();

    const existingByKey = new Map<
        string,
        { id: string; identity_kind: string; identity_value: string }
    >();
    for (const row of existing.results ?? []) {
        existingByKey.set(doKey(row.identity_kind, row.identity_value), row);
    }

    const stmts: D1PreparedStatement[] = [];

    // UPSERT each DO row as pending. Existing pending rows get their
    // role/expiry refreshed; new rows get a fresh id.
    for (const [key, row] of doRowsByKey) {
        const existingRow = existingByKey.get(key);
        if (existingRow) {
            stmts.push(
                d1
                    .prepare(
                        `UPDATE entity_invitations_index
                         SET role = ?, inviter_account_id = ?,
                             time_created = ?, time_expires = ?
                         WHERE id = ?`
                    )
                    .bind(
                        row.role,
                        row.inviter_account_id,
                        row.time_created,
                        row.time_expires,
                        existingRow.id
                    )
            );
        } else {
            stmts.push(
                d1
                    .prepare(
                        `INSERT INTO entity_invitations_index (
                            id, target_id, target_type, identity_kind,
                            identity_value, role, inviter_account_id,
                            status, time_created, time_expires
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
                    )
                    .bind(
                        newIdForRow(),
                        targetId,
                        targetType,
                        row.identity_kind,
                        row.identity_value,
                        row.role,
                        row.inviter_account_id,
                        row.time_created,
                        row.time_expires
                    )
            );
        }
    }

    // Mark missing-in-DO pending rows as revoked.
    for (const [key, row] of existingByKey) {
        if (doRowsByKey.has(key)) continue;
        stmts.push(
            d1
                .prepare(
                    `UPDATE entity_invitations_index
                     SET status = 'revoked'
                     WHERE id = ?`
                )
                .bind(row.id)
        );
    }

    if (stmts.length === 0) return;
    await d1.batch(stmts);
}

/**
 * Count invitations created by a single account within a sliding
 * window. Used by the per-inviter rate limit (default 10/hour;
 * ADR 0009 §"Other policy defaults"). Status-agnostic — abuse vector
 * is "how many email sends triggered" not "how many are outstanding."
 *
 * Caller passes `sinceMs` as a unix-seconds threshold (e.g. now - 3600).
 */
export async function CountInvitesByInviterSince(
    d1: D1Database,
    inviterAccountId: string,
    sinceSeconds: number
): Promise<number> {
    const row = await d1
        .prepare(
            `SELECT COUNT(*) AS c
             FROM entity_invitations_index
             WHERE inviter_account_id = ? AND time_created >= ?`
        )
        .bind(inviterAccountId, sinceSeconds)
        .first<{ c: number }>();
    return row?.c ?? 0;
}

/**
 * Count an inviter's currently outstanding (pending) invitations
 * across all targets. Default cap 25 per ADR 0009.
 */
export async function CountOutstandingInvitesByInviter(
    d1: D1Database,
    inviterAccountId: string
): Promise<number> {
    const row = await d1
        .prepare(
            `SELECT COUNT(*) AS c
             FROM entity_invitations_index
             WHERE inviter_account_id = ? AND status = 'pending'`
        )
        .bind(inviterAccountId)
        .first<{ c: number }>();
    return row?.c ?? 0;
}

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
export const INVITE_MAX_OUTSTANDING_PER_INVITER = 25;

/**
 * Per-inviter rate cap over the last hour. Enforced at the HTTP
 * `/push` preflight against `entity_invitations_index.time_created`
 * (status-agnostic — abuse vector is "how many sends fired", not "how
 * many are still open").
 */
export const INVITE_MAX_PER_INVITER_PER_HOUR = 10;

/**
 * Deps for `preflightInviteByIdentity`. Injected as functions rather
 * than passing a raw D1 binding so this stays pure-ish: tests can stub
 * each query, and the `/push` route binds them once against
 * `c.env.DJIBB_AUTH`.
 */
export type InvitePreflightDeps = {
    countInvitesByInviterSince: (
        inviterAccountId: string,
        sinceSeconds: number
    ) => Promise<number>;
    countOutstandingInvitesByInviter: (
        inviterAccountId: string
    ) => Promise<number>;
    /**
     * Resolve a (lower-cased) email to an existing Account. Used for the
     * "already a member" pre-check. Return `null` when no account
     * matches — that's the common case (inviting a non-djibb user), and
     * we still let the invite through.
     */
    getAccountIdByEmail: (
        normalizedEmail: string
    ) => Promise<string | null>;
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

export type InvitePreflightFailureReason =
    | 'unauthenticated_inviter'
    | 'session_mismatch'
    | 'entity_missing'
    | 'rate_limit_hour'
    | 'outstanding_cap'
    | 'already_member'
    | 'self_invite';

export type InvitePreflightResult =
    | { ok: true }
    | { ok: false; reason: InvitePreflightFailureReason; message: string };

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
export async function preflightInviteByIdentity(
    deps: InvitePreflightDeps,
    input: InvitePreflightInput
): Promise<InvitePreflightResult> {
    const inviter = input.inviter_account_id;
    if (!inviter) {
        return {
            ok: false,
            reason: 'unauthenticated_inviter',
            message: 'Sign in to send invitations.',
        };
    }
    if (!input.sessionAccountIds.includes(inviter)) {
        return {
            ok: false,
            reason: 'session_mismatch',
            message: 'Inviter account is not in the current session.',
        };
    }
    if (input.authorization_rules == null) {
        return {
            ok: false,
            reason: 'entity_missing',
            message: 'Cannot invite to an entity that has not been initialized.',
        };
    }

    // Rate limit (per inviter, last hour). Status-agnostic.
    const recent = await deps.countInvitesByInviterSince(
        inviter,
        input.nowSeconds - 60 * 60
    );
    if (recent >= INVITE_MAX_PER_INVITER_PER_HOUR) {
        return {
            ok: false,
            reason: 'rate_limit_hour',
            message: `Rate limit: max ${INVITE_MAX_PER_INVITER_PER_HOUR} invitations per hour.`,
        };
    }

    // Outstanding cap (per inviter, all targets).
    const outstanding = await deps.countOutstandingInvitesByInviter(inviter);
    if (outstanding >= INVITE_MAX_OUTSTANDING_PER_INVITER) {
        return {
            ok: false,
            reason: 'outstanding_cap',
            message: `Outstanding-invite cap reached (${INVITE_MAX_OUTSTANDING_PER_INVITER}). Revoke some pending invitations first.`,
        };
    }

    // Identity-resolution checks. v1 = email only.
    if (input.identity_kind === 'email') {
        const normalized = normalizeIdentityValue('email', input.identity_value);
        const targetAccountId = await deps.getAccountIdByEmail(normalized);
        if (targetAccountId) {
            if (targetAccountId === inviter) {
                return {
                    ok: false,
                    reason: 'self_invite',
                    message: 'You cannot invite yourself.',
                };
            }
            // v1 conservatively checks the entity's explicit grants
            // only. Workspace-inherited access is *not* "already a
            // member" for invite purposes — those users still need an
            // explicit per-entity grant to collaborate beyond the
            // workspace default role.
            const existing =
                input.authorization_rules.authorized_accounts[targetAccountId];
            if (existing) {
                return {
                    ok: false,
                    reason: 'already_member',
                    message:
                        'That account already has access to this entity.',
                };
            }
        }
    }

    return { ok: true };
}

export async function DeleteInvitationsForTarget(
    d1: D1Database,
    targetId: string
): Promise<void> {
    await d1
        .prepare(`DELETE FROM entity_invitations_index WHERE target_id = ?`)
        .bind(targetId)
        .run();
}

// ---------- Accept-side helpers ----------

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
export async function GetInvitationFromIndex(
    d1: D1Database,
    {
        targetId,
        identity_kind,
        identity_value,
    }: {
        targetId: string;
        identity_kind: InvitationIdentityKind;
        identity_value: string;
    }
): Promise<PendingIndexRow | null> {
    const row = await d1
        .prepare(
            `SELECT id, target_id, target_type, identity_kind, identity_value,
                    role, inviter_account_id, status, time_created, time_expires
             FROM entity_invitations_index
             WHERE target_id = ?
               AND identity_kind = ?
               AND identity_value = ?
             LIMIT 1`
        )
        .bind(targetId, identity_kind, identity_value)
        .first<PendingIndexRow>();
    return row ?? null;
}

/**
 * Flip the matching D1 index row from `status='pending'` to
 * `status='accepted'`. Called from the DO push handler's post-commit
 * tail BEFORE `EmitInvitationsSnapshot` runs — otherwise the
 * reconciler's "missing in DO ⇒ revoked" rule would clobber the
 * accept (the DO row was tombstoned by the mutator). No-op if the row
 * isn't currently pending (idempotent under retry).
 */
export async function MarkInvitationsAccepted(
    d1: D1Database,
    targetId: string,
    accepted: ReadonlyArray<{
        identity_kind: InvitationIdentityKind;
        identity_value: string;
    }>
): Promise<void> {
    if (accepted.length === 0) return;
    const stmts = accepted.map(a =>
        d1
            .prepare(
                `UPDATE entity_invitations_index
                 SET status = 'accepted'
                 WHERE target_id = ?
                   AND identity_kind = ?
                   AND identity_value = ?
                   AND status = 'pending'`
            )
            .bind(targetId, a.identity_kind, a.identity_value)
    );
    await d1.batch(stmts);
}

// ---------- Accept preflight ----------

export type AcceptPreflightDeps = {
    /**
     * Look up the D1 index row matching the entity + identity. Null
     * when no row matches (link revoked, never created, or wrong
     * entity). Caller is expected to normalize `identity_value` first.
     */
    getInvitationFromIndex: (
        targetId: string,
        identity_kind: InvitationIdentityKind,
        identity_value: string
    ) => Promise<PendingIndexRow | null>;
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

export type AcceptPreflightFailureReason =
    | 'unauthenticated_acceptor'
    | 'session_mismatch'
    | 'identity_unverified'
    | 'invitation_not_found'
    | 'invitation_expired'
    | 'invitation_not_pending';

export type AcceptPreflightResult =
    | {
          ok: true;
          /** Normalized identity (lower-cased for email) so the DO mutator
           *  uses the same key the index resolved against. */
          normalized_identity_value: string;
          /** D1 row that resolved — caller can carry the role / inviter
           *  forward into the mutator if a future variant wants them. */
          index_row: PendingIndexRow;
      }
    | {
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
export async function preflightAcceptInvitation(
    deps: AcceptPreflightDeps,
    input: AcceptPreflightInput
): Promise<AcceptPreflightResult> {
    const acceptor = input.acceptor_account_id;
    if (!acceptor) {
        return {
            ok: false,
            reason: 'unauthenticated_acceptor',
            message: 'Sign in to accept invitations.',
        };
    }
    const sessionMatch = input.sessionAccounts.find(a => a.id === acceptor);
    if (!sessionMatch) {
        return {
            ok: false,
            reason: 'session_mismatch',
            message: 'Acceptor account is not in the current session.',
        };
    }

    const normalized = normalizeIdentityValue(
        input.identity_kind,
        input.identity_value
    );

    // Identity ownership. v1 = email only. The acceptor's session
    // account must have a verified email matching the invitation's
    // (normalized) identity value — otherwise anyone with a session
    // could accept anyone else's invite link.
    if (input.identity_kind === 'email') {
        const verified =
            sessionMatch.email_verified === true &&
            typeof sessionMatch.email === 'string' &&
            sessionMatch.email.trim().toLowerCase() === normalized;
        if (!verified) {
            return {
                ok: false,
                reason: 'identity_unverified',
                message:
                    'This invitation is for a different email than the one you have verified on this account.',
            };
        }
    }

    const indexRow = await deps.getInvitationFromIndex(
        input.target_id,
        input.identity_kind,
        normalized
    );
    if (!indexRow) {
        return {
            ok: false,
            reason: 'invitation_not_found',
            message: 'No invitation found for this link.',
        };
    }
    if (indexRow.status !== 'pending') {
        return {
            ok: false,
            reason: 'invitation_not_pending',
            message: `This invitation is already ${indexRow.status}.`,
        };
    }
    if (indexRow.time_expires < input.nowSeconds) {
        return {
            ok: false,
            reason: 'invitation_expired',
            message: 'This invitation has expired. Ask the sender to send a new one.',
        };
    }

    return {
        ok: true,
        normalized_identity_value: normalized,
        index_row: indexRow,
    };
}
