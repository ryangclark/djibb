import { z } from 'zod';

import { NotFoundError } from '../../errors';
import { AccountRoleEnum } from '@djibb/protocol/auth/rules';
import { ListSchema } from '@djibb/protocol/list';
import {
    InvitationIdentityKindEnum,
    normalizeIdentityValue,
    tombstonePendingInvite,
} from '../invitations';
import { setListVersion } from '../sql';
import { OWNER_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * ADR 0009 — revoke a pending invitation. Hard-deletes from the DO's
 * `pending_invites`; the post-commit reconciler marks the
 * corresponding D1 index row `status='revoked'` (audit retained).
 *
 * Set-family-ish: the inverse is `inviteByIdentity` with the
 * pre-revoke role and inviter restored. `capturePreState` reads from
 * the Replicache cache so undo can repopulate those fields.
 *
 * The Revoke verb is distinct from `setListAuthRules`'s "Remove
 * access" — Revoke acts on a pending invitation; Remove acts on an
 * accepted membership. ADR 0009 §"Verbs: Revoke vs Remove."
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    identity_kind: InvitationIdentityKindEnum,
    identity_value: z.string().min(3).max(254),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'revokeInvitation' as const;
export const requiredRole = OWNER_ROLES;

/**
 * Pre-state for undo: the role, inviter, and expiry from the
 * pre-revoke row. The forward call doesn't carry these — they live on
 * the DO row — so the inverse needs the cache snapshot to reconstruct
 * a fresh invite. `time_created` is intentionally NOT captured —
 * re-invite resets the clock; preserving the original would let
 * undone-revokes expire instantly.
 */
export type RevokePreState = {
    role?: string;
    inviter_account_id?: string;
};

export const server: ServerMutator<Args> = (
    { listId, identity_kind, identity_value },
    { sql, nextVersion, timestamp_client }
) => {
    const normalizedValue = normalizeIdentityValue(
        identity_kind,
        identity_value
    );

    const nowSeconds = Math.floor(
        (timestamp_client ?? new Date()).getTime() / 1000
    );

    // Soft-delete (tombstone) — the row survives in DO storage with
    // `time_deleted` set + version bumped, so the pull keyspace
    // surfaces `op:'del'` to clients that had previously cached the
    // row (ADR 0009 Slice 2). The post-commit reconciler picks up the
    // disappearance from `listPendingInvites` and flips the D1 audit
    // row to status='revoked'.
    const tombstoned = tombstonePendingInvite(sql, {
        identity_kind,
        identity_value: normalizedValue,
        nowSeconds,
        version: nextVersion,
    });
    if (!tombstoned) {
        // No live invite to revoke — could be already accepted,
        // already revoked, or never existed. All three are idempotent
        // no-ops from the client's perspective; surface as 'gone'.
        return { status: 'gone' };
    }

    // Bump entity version so the next pull diffs surface the
    // invite's removal (Slice 2 emits `op:'del'` for the key).
    try {
        setListVersion(sql, nextVersion);
    } catch (error) {
        console.warn('`revokeInvitation` setListVersion warned:', error);
    }
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, identity_kind, identity_value },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`entity "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & { version?: number };

    const normalizedValue =
        identity_kind === 'email'
            ? identity_value.trim().toLowerCase()
            : identity_value.trim();
    const inviteKey = `pending_invites/${normalizedValue}`;

    await tx.del(inviteKey);

    const ts = timestamp_client ?? new Date();
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

export const capturePreState: CapturePreState<Args> = async (
    tx,
    { identity_kind, identity_value }
) => {
    const normalizedValue =
        identity_kind === 'email'
            ? identity_value.trim().toLowerCase()
            : identity_value.trim();
    const inviteKey = `pending_invites/${normalizedValue}`;
    const raw = await tx.get(inviteKey);
    if (!raw) return {};
    const row = raw as Record<string, unknown>;
    return {
        role: row.role,
        inviter_account_id: row.inviter_account_id,
    };
};

export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || preState.role === undefined) {
        // No cached pre-state — can't restore the role. Skip undo.
        return null;
    }
    const role = AccountRoleEnum.safeParse(preState.role);
    if (!role.success) return null;
    return {
        name: 'inviteByIdentity',
        args: {
            listId: args.listId,
            identity_kind: args.identity_kind,
            identity_value: args.identity_value,
            role: role.data,
        },
    };
};
