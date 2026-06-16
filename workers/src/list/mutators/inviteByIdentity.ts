import { z } from 'zod';

import { InvitableRoleEnum } from '@djibb/protocol/auth/rules';
import { BadMutationError, NotFoundError } from '../../errors';
import { ListSchema } from '..';
import {
    INVITATION_TTL_MS,
    InvitationIdentityKindEnum,
    insertPendingInvite,
    getPendingInvite,
    normalizeIdentityValue,
} from '../invitations';
import { setListVersion } from '../sql';
import { OWNER_ROLES, toStoredValue } from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * ADR 0009 — create a pending invitation on an entity's
 * `pending_invites` table. The invitation is identified by
 * `(identity_kind, identity_value)`; v1 only supports `email`. No
 * bearer token is generated — recipient is matched on verified
 * identity at accept time.
 *
 * Owner-gated (mirrors `setListAuthRules`'s `requiredRole`); a passing
 * stranger on an ownerless list cannot invite collaborators.
 *
 * `role` is an `InvitableRole` (`AccountRole` minus `owner`): ownership
 * is transferred via `transferOwnership`, never invited. This also
 * stops an `admin` — who passes the `OWNER_ROLES` gate — from minting a
 * second `owner` through the invite path, which `changeMemberRole`
 * already forbids on the direct-grant path.
 *
 * The mutator is constructive — inverse is `revokeInvitation` with the
 * same (kind, value). No pre-state needed; the identity is in the
 * forward args.
 *
 * "Already a member" pre-check is intentionally deferred. The DO
 * cannot map `email -> account_id` synchronously (the lookup is in
 * D1); the check belongs at the HTTP push handler or a future
 * pre-flight slice. Lacking the check, the invite is created and
 * `acceptInvitation` (future slice) will surface the no-op if the
 * invitee turns out to already be a member.
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    identity_kind: InvitationIdentityKindEnum,
    identity_value: z.string().min(3).max(254),
    role: InvitableRoleEnum,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'inviteByIdentity' as const;
export const requiredRole = OWNER_ROLES;

export const server: ServerMutator<Args> = (
    { listId, identity_kind, identity_value, role },
    { sql, nextVersion, accountId, timestamp_client }
) => {
    const inviter_account_id = accountId;
    if (!inviter_account_id) {
        // Invitations require an authenticated inviter. The DO push
        // handler already validates `envelope.accountId` belongs to
        // the session's authorized accounts; we just need it
        // populated. Surface as `gone` rather than throwing — the
        // runtime treats missing-precondition as a structured no-op.
        console.warn('`inviteByIdentity` missing envelope.accountId');
        throw new BadMutationError(
            'inviteByIdentity requires an authenticated inviter'
        );
    }

    const normalizedValue = normalizeIdentityValue(
        identity_kind,
        identity_value
    );

    // Reject duplicates against the DO's own pending_invites. The
    // (kind, value) primary key would conflict on insert; the
    // explicit check converts it to a structured 'stale' outcome and
    // surfaces a friendlier error path.
    const existing = getPendingInvite(sql, {
        identity_kind,
        identity_value: normalizedValue,
    });
    if (existing) {
        return { status: 'stale' };
    }

    // Timestamps in unix seconds (matches the rest of the DO sql).
    const nowMs = (timestamp_client ?? new Date()).getTime();
    const time_created = Math.floor(nowMs / 1000);
    const time_expires = Math.floor((nowMs + INVITATION_TTL_MS) / 1000);

    insertPendingInvite(sql, {
        identity_kind,
        identity_value: normalizedValue,
        role,
        inviter_account_id,
        time_created,
        time_expires,
        time_deleted: null, // live row; the INSERT hardcodes NULL too
        version: nextVersion,
    });

    // Bump entity version so the next pull diffs include this
    // invitation (Slice 2 wires the pull surface). The standard push
    // tail also calls `setListVersion`, but it pulls from
    // `listVersion`; doing it here means the bump survives even if
    // the entity row was archived and the standard path no-ops.
    try {
        setListVersion(sql, nextVersion);
    } catch (error) {
        // setListVersion logs on rowsWritten mismatch but doesn't
        // throw. Defensive in case that policy changes.
        console.warn('`inviteByIdentity` setListVersion warned:', error);
    }
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, identity_kind, identity_value, role },
    { accountId, timestamp_client }
) => {
    // Optimistic-local stub. The full client surface lands in Slice 2
    // when the pull filter starts emitting `pending_invites/*` keys.
    // For now: best-effort local mirror so undo can read back the
    // optimistic state. Owners get the authoritative copy from the
    // next pull.
    const inviter_account_id = accountId;
    if (!inviter_account_id) return;

    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`entity "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & { version?: number };

    const nowMs = (timestamp_client ?? new Date()).getTime();
    const normalizedValue =
        identity_kind === 'email'
            ? identity_value.trim().toLowerCase()
            : identity_value.trim();
    const inviteKey = `pending_invites/${normalizedValue}`;

    await tx.set(
        inviteKey,
        toStoredValue({
            identity_kind,
            identity_value: normalizedValue,
            role,
            inviter_account_id,
            time_created: Math.floor(nowMs / 1000),
            time_expires: Math.floor((nowMs + INVITATION_TTL_MS) / 1000),
            version: (entity.version ?? 0) + 1,
        })
    );

    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            time_updated: new Date(nowMs).toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

export const inverse: Inverse<Args> = args => ({
    name: 'revokeInvitation',
    args: {
        listId: args.listId,
        identity_kind: args.identity_kind,
        identity_value: args.identity_value,
    },
});
