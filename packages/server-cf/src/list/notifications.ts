/**
 * Push post-commit invitation & ownership-notification tail (ADR 0026
 * series 2). The DO-resident side effects of a committed push that
 * concern invitations and ownership transfer:
 *
 *   - `emitInvitationsSnapshot` — reconcile this DO's `pending_invites`
 *     into D1's `entity_invitations_index` (ADR 0009).
 *   - `fireInvitationEmails` — notify invitees of `inviteByIdentity`
 *     mutations that committed (ADR 0009 §"Email send").
 *   - `fireOwnershipTransferEmails` — notify both parties of each
 *     `transferOwnership` (ADR 0011 §Decision C, Phase 5).
 *
 * Carved out of `durable_object.ts` into `sql.ts`-idiom free functions
 * with explicit deps (no `this`), so the URL/slug-resolution + best-
 * effort send logic is directly testable (ADR 0026 §Decision). The
 * `_handlePush` tail invokes `applyInvitationPostCommit`, which folds
 * the `MarkInvitationsAccepted` flip, the invitations-index reconcile,
 * and the two email fires with their guards + try/catch ordering.
 *
 * All effects are best-effort: failures are logged, never thrown. The DO
 * is authoritative and the reconciliation alarm (ADR 0007) repairs
 * persistent D1 drift; a bounced email is recoverable by a resend
 * surface.
 */
import { isEntityRow } from '@djibb/protocol/list';
import type { Account } from '@djibb/protocol/account';
import { newId } from '@djibb/protocol/id';

import { getElementById } from './sql';
import { listPendingInvites, type InvitationIdentityKind } from './invitations';
import {
    EmitInvitationsSnapshot,
    GetWorkspaceSlug,
    MarkInvitationsAccepted,
} from '../derived-index/d1';
import { GetAccountById } from '../auth/d1';
import {
    sendEntityInvitationEmail,
    sendOwnershipTransferEmail,
    sendOwnershipTransferReceiptEmail,
} from '../email';
import type { Bindings } from '..';

/**
 * Reconcile this DO's `pending_invites` into D1's
 * `entity_invitations_index` (ADR 0009). Called post-commit when a push
 * touched any INVITATION_MUTATORS. Full-snapshot pattern: DO rows are
 * UPSERTed as 'pending'; D1 'pending' rows that no longer correspond to
 * a DO row become 'revoked'.
 *
 * The entity-not-found branch (DO ran an invitation mutator but its own
 * `list_elements` row is missing) is an invariant violation — logged and
 * skipped, not thrown, mirroring `emitEntitySnapshot`.
 */
export async function emitInvitationsSnapshot(
    sql: SqlStorage,
    d1: D1Database,
    entityId: string
): Promise<void> {
    const entity = getElementById(sql, entityId);
    if (!entity || !isEntityRow(entity)) {
        console.warn(
            `\`emitInvitationsSnapshot()\` no entity row for "${entityId}"`
        );
        return;
    }

    const doInvites = listPendingInvites(sql);
    await EmitInvitationsSnapshot(d1, {
        targetId: entityId,
        targetType: entity.type,
        doInvites,
        newIdForRow: () => newId('invitation'),
    });
}

/**
 * Build the canonical entity URL base (`origin` + type-prefixed path +
 * slug-or-id-suffix) shared by both email fires. First domain in the
 * semicolon-separated `AUTHORIZED_DOMAINS` is canonical for outbound
 * links (matches the workspace-invite pattern in `workspace/fetch.ts`).
 * Workspaces route by slug (`/w/<slug>`, ADR 0011 §7b.5) resolved from
 * the D1 catalog — the DO's local sql doesn't carry it; lists/templates
 * route by id suffix. Falls back to the id suffix if the slug is
 * missing so the link still names the right DO. `logPrefix` names the
 * calling method in the warn logs.
 */
async function resolveEntityBaseUrl(
    env: Bindings,
    d1: D1Database,
    entityId: string,
    entityTypeLabel: string,
    logPrefix: string
): Promise<string> {
    const origin = (env.AUTHORIZED_DOMAINS ?? '').split(';')[0] ?? '';
    if (!origin) {
        console.warn(`${logPrefix} no AUTHORIZED_DOMAINS; using relative URL.`);
    }
    // URL prefix mirrors the entity ID's type prefix (`l/`, `t/`, `w/`)
    // — see user memory note "URLs mirror ID type prefixes".
    const pathPrefix =
        entityTypeLabel === 'list'
            ? '/l/'
            : entityTypeLabel === 'workspace'
              ? '/w/'
              : '/t/';
    // ID prefix lives in the entity id (`l/<suffix>`) but the URL form
    // strips the prefix segment (see user memory: `/l/<suffix>` not
    // `/l/l/<suffix>`).
    const idSuffix = entityId.includes('/') ? entityId.split('/')[1] : entityId;
    let pathSegment = idSuffix;
    if (entityTypeLabel === 'workspace') {
        const slug = await GetWorkspaceSlug(d1, entityId);
        if (slug) {
            pathSegment = slug;
        } else {
            console.warn(
                `${logPrefix} no slug for workspace "${entityId}"; using id suffix.`
            );
        }
    }
    return `${origin}${pathPrefix}${pathSegment}`;
}

/**
 * Send notification emails for invitations that committed in this push
 * (ADR 0009 §"Email send"). One email per recipient. The `acceptUrl`
 * points directly to the entity page with `?from_invite=1`; the entity
 * route handles its own redirect-to-login for unauthenticated invitees
 * and a banner picks up the flag to surface an explicit "accept"
 * affordance.
 *
 * Best-effort: failures are logged, never thrown. Concurrent sends are
 * awaited via `Promise.allSettled` so one slow recipient doesn't
 * serialize the rest. The DO's input gate keeps the object alive while
 * these promises resolve, so we don't need `executionCtx.waitUntil`
 * (which isn't available inside the DO anyway).
 */
export async function fireInvitationEmails(
    sql: SqlStorage,
    env: Bindings,
    entityId: string,
    invites: ReadonlyArray<{
        identity_kind: InvitationIdentityKind;
        identity_value: string;
        inviter_account_id: string;
    }>,
    authorizedAccounts: Readonly<Account[]>
): Promise<void> {
    const entity = getElementById(sql, entityId);
    if (!entity || !isEntityRow(entity)) {
        console.warn(
            `\`fireInvitationEmails()\` no entity row for "${entityId}"`
        );
        return;
    }
    const entityName = (entity as { name?: string }).name ?? '';
    const entityTypeLabel = entity.type;

    if (!env.EMAIL) {
        console.warn(
            '`fireInvitationEmails()` no EMAIL binding; skipping send.'
        );
        return;
    }

    const d1 = env.DJIBB_AUTH;
    const base = await resolveEntityBaseUrl(
        env,
        d1,
        entityId,
        entityTypeLabel,
        '`fireInvitationEmails()`'
    );
    const acceptUrl = `${base}?from_invite=1`;

    const sends = invites.map(async (invite) => {
        // v1 only supports email-kind identities.
        if (invite.identity_kind !== 'email') return;
        const inviter = authorizedAccounts.find(
            (a) => a.id === invite.inviter_account_id
        );
        const inviterName = inviter?.display_name ?? '';
        try {
            await sendEntityInvitationEmail(env, {
                to: invite.identity_value,
                entityTypeLabel,
                entityName,
                inviterName,
                acceptUrl,
            });
        } catch (error) {
            console.error(
                `\`sendEntityInvitationEmail()\` failed for "${entityId}" -> "${invite.identity_value}":`,
                error
            );
        }
    });
    await Promise.allSettled(sends);
}

/**
 * Email both parties of each `transferOwnership` that committed in this
 * push (ADR 0011 §Decision C, Phase 5): a notification to the new owner
 * ("you're now the owner") and a receipt to the former owner ("you
 * transferred X" — an accountability / compromise signal). Mirrors
 * `fireInvitationEmails`' best-effort posture: per-send failures are
 * logged via `Promise.allSettled`, never thrown. The two sends are
 * independent — a missing new-owner email doesn't suppress the former
 * owner's receipt.
 *
 * Unlike the invite path the new owner is identified by account id, not
 * an email literal, so we resolve it from D1 (`GetAccountById`); that
 * one lookup feeds both emails. The former owner is the actor, read
 * straight from the session's `authorizedAccounts`. The link carries no
 * `?from_invite=1`: the transfer already granted `owner` access, so
 * there's nothing to accept.
 */
export async function fireOwnershipTransferEmails(
    sql: SqlStorage,
    env: Bindings,
    entityId: string,
    transfers: ReadonlyArray<{
        to_account_id: string;
        former_owner_account_id: string | null;
    }>,
    authorizedAccounts: Readonly<Account[]>
): Promise<void> {
    const entity = getElementById(sql, entityId);
    if (!entity || !isEntityRow(entity)) {
        console.warn(
            `\`fireOwnershipTransferEmails()\` no entity row for "${entityId}"`
        );
        return;
    }
    const entityName = (entity as { name?: string }).name ?? '';
    const entityTypeLabel = entity.type;

    if (!env.EMAIL) {
        console.warn(
            '`fireOwnershipTransferEmails()` no EMAIL binding; skipping send.'
        );
        return;
    }
    const d1 = env.DJIBB_AUTH;

    const entityUrl = await resolveEntityBaseUrl(
        env,
        d1,
        entityId,
        entityTypeLabel,
        '`fireOwnershipTransferEmails()`'
    );

    const sends = transfers.map(async (transfer) => {
        // Former owner = the actor, resolved from the in-session accounts
        // (carries both display_name and email; no D1 read).
        const formerOwner = transfer.former_owner_account_id
            ? authorizedAccounts.find(
                  (a) => a.id === transfer.former_owner_account_id
              )
            : undefined;
        const formerOwnerName = formerOwner?.display_name ?? '';

        // New owner needs a D1 lookup — they're identified by id, and
        // (unlike the actor) aren't in the session. One lookup feeds both
        // emails: their email for the notification, their name for the
        // former owner's receipt.
        const recipient = await GetAccountById(
            d1,
            transfer.to_account_id
        ).catch((err) => {
            console.error(
                `\`fireOwnershipTransferEmails()\` GetAccountById failed for "${transfer.to_account_id}":`,
                err
            );
            return null;
        });

        // 1. Notify the new owner.
        const newOwnerEmail = recipient?.email;
        if (newOwnerEmail) {
            try {
                await sendOwnershipTransferEmail(env, {
                    to: newOwnerEmail,
                    entityTypeLabel,
                    entityName,
                    formerOwnerName,
                    entityUrl,
                });
            } catch (error) {
                console.error(
                    `\`sendOwnershipTransferEmail()\` failed for "${entityId}" -> "${transfer.to_account_id}":`,
                    error
                );
            }
        } else {
            console.warn(
                `\`fireOwnershipTransferEmails()\` no email for new owner "${transfer.to_account_id}" of "${entityId}"; skipping notification.`
            );
        }

        // 2. Receipt to the former owner (accountability / account-
        // compromise signal). Independent of (1): a missing new-owner
        // email shouldn't suppress the former owner's record of the
        // change.
        const formerOwnerEmail = formerOwner?.email;
        if (formerOwnerEmail) {
            const newOwnerName =
                recipient?.display_name || recipient?.email || '';
            try {
                await sendOwnershipTransferReceiptEmail(env, {
                    to: formerOwnerEmail,
                    entityTypeLabel,
                    entityName,
                    newOwnerName,
                    entityUrl,
                });
            } catch (error) {
                console.error(
                    `\`sendOwnershipTransferReceiptEmail()\` failed for "${entityId}" -> former owner "${transfer.former_owner_account_id}":`,
                    error
                );
            }
        }
    });
    await Promise.allSettled(sends);
}

export interface InvitationPostCommitDeps {
    sql: SqlStorage;
    d1: D1Database; // env.DJIBB_AUTH
    env: Bindings; // EMAIL + AUTHORIZED_DOMAINS + senders, for the email fires
    authorizedAccounts: Readonly<Account[]>;
    /**
     * Hand the notification emails to the runtime (`ctx.waitUntil`) so they
     * settle *after* the push response goes out, instead of stalling the
     * user's ack on an outbound network call. The DO injects this; unit
     * tests and direct callers omit it and get inline `await` semantics.
     */
    waitUntil?: (promise: Promise<unknown>) => void;
}

export interface InvitationPostCommitFlags {
    entityId: string;
    // (kind, value) pairs whose pending_invite was accepted this push.
    acceptedInvites: ReadonlyArray<{
        identity_kind: InvitationIdentityKind;
        identity_value: string;
    }>;
    // True if any mutation touched the DO's pending_invites table.
    invitationsMutated: boolean;
    // inviteByIdentity sends captured this push.
    sentInvites: ReadonlyArray<{
        identity_kind: InvitationIdentityKind;
        identity_value: string;
        inviter_account_id: string;
    }>;
    // transferOwnership transfers captured this push.
    transferredOwnerships: ReadonlyArray<{
        to_account_id: string;
        former_owner_account_id: string | null;
    }>;
}

/**
 * Post-commit invitation/ownership tail of `_handlePush` (ADR 0009,
 * ADR 0011 §Decision C). Runs after the push's mutations have committed
 * and the *entity* snapshot has emitted (the entity-metadata emit stays
 * on the DO — it also serves reconcile). Ordered:
 *
 *   1. `MarkInvitationsAccepted` — flip D1 index rows to 'accepted'
 *      BEFORE the reconciler's diff, so accepted rows (tombstoned in the
 *      DO) aren't misclassified as 'revoked' (ADR 0009 Slice 3).
 *   2. invitations-index reconcile — DO rows → D1 'pending', absent D1
 *      'pending' rows → 'revoked'.
 *   3. invite notification emails.
 *   4. ownership-transfer emails.
 *
 * Steps 1-2 are fire-and-pray (logged, not thrown): the DO is
 * authoritative and the reconciliation alarm repairs drift. Steps 3-4
 * are best-effort internally. The `MarkInvitationsAccepted` ordering
 * before the reconcile is load-bearing; the email fires are order-
 * independent of the rest.
 */
export async function applyInvitationPostCommit(
    deps: InvitationPostCommitDeps,
    flags: InvitationPostCommitFlags
): Promise<void> {
    const { sql, d1, env, authorizedAccounts } = deps;
    const { entityId } = flags;

    if (flags.acceptedInvites.length > 0) {
        try {
            await MarkInvitationsAccepted(d1, entityId, flags.acceptedInvites);
        } catch (error) {
            console.error(
                `\`MarkInvitationsAccepted()\` D1 emit failed for "${entityId}":`,
                error
            );
        }
    }

    if (flags.invitationsMutated) {
        try {
            await emitInvitationsSnapshot(sql, d1, entityId);
        } catch (error) {
            console.error(
                `\`emitInvitationsSnapshot()\` D1 emit failed for "${entityId}":`,
                error
            );
        }
    }

    // The two D1 steps above stay on the request: the worker's middleware
    // reads D1 for auth on the *next* round-trip, so the push must not ack
    // until the index is caught up.
    //
    // The emails below are the opposite. Nothing about the DO's consistency
    // depends on them — they are best-effort notifications, and the sends
    // carry a bounded retry (`transientEmailRetry`). Awaiting them here put
    // an outbound network call, backoff and all, on the user's push ack:
    // a flaky provider stalled the click. Hand them to the runtime instead
    // (`ctx.waitUntil`), which keeps the isolate alive until they settle
    // *after* the response goes out.
    //
    // `waitUntil` is optional so direct callers and unit tests still get
    // deterministic inline behavior — absent it, the sends are awaited.
    const emailFires: Promise<unknown>[] = [];

    if (flags.sentInvites.length > 0) {
        emailFires.push(
            fireInvitationEmails(
                sql,
                env,
                entityId,
                flags.sentInvites,
                authorizedAccounts
            )
        );
    }

    if (flags.transferredOwnerships.length > 0) {
        emailFires.push(
            fireOwnershipTransferEmails(
                sql,
                env,
                entityId,
                flags.transferredOwnerships,
                authorizedAccounts
            )
        );
    }

    if (emailFires.length > 0) {
        // Both fire* helpers already swallow per-recipient failures via
        // `Promise.allSettled`; this outer settle is belt-and-braces so an
        // unexpected throw can never reject a detached promise.
        const settled = Promise.allSettled(emailFires);
        if (deps.waitUntil) {
            deps.waitUntil(settled);
        } else {
            await settled;
        }
    }
}
