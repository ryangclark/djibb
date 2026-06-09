import { z } from 'zod';

import {
    AuthorizationRoleEnum,
    type AuthorizationRole,
    type AuthorizationRules,
} from '../../auth/rules';
import { BadMutationError, NotFoundError } from '../../errors';
import { ENTITY_ROW_TYPES_SQL_LIST, ListSchema } from '..';
import {
    InvitationIdentityKindEnum,
    getPendingInvite,
    normalizeIdentityValue,
    tombstonePendingInvite,
} from '../invitations';
import { setEntityAuthorizationRules, setListVersion } from '../sql';
import { toStoredValue } from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * ADR 0009 Slice 3 — accept a pending invitation. The invitee's session
 * carries an authenticated account; this mutator promotes that account
 * to the role recorded on the matching `pending_invites` row and
 * tombstones the row in the same DO commit. The post-commit emit path
 * marks the corresponding D1 index row `status='accepted'` (separate
 * code path from the reconciler so the row isn't downgraded to revoked
 * by the "missing in DO" diff).
 *
 * Special role surface. The mutator's `requiredRole` covers *every*
 * AuthorizationRole — including `restricted`. The role gate is the
 * thing being modified here: a brand-new invitee resolves to
 * `restricted` until this mutator commits, so demanding any higher role
 * would make acceptance unreachable. The HTTP `/push` boundary
 * separately exempts accept-only pushes from its own `restricted`
 * block (see `fetch.ts`), and enforces identity ownership via
 * `preflightAcceptInvitation` so a `restricted` caller can't ride this
 * exemption to run anything else.
 *
 * Constructive — no pre-state needed; the identity + listId are in the
 * forward args. Intentionally NOT undoable: an "undo accept" would
 * either silently strip the user's access (surprising) or recreate a
 * pending invite they could re-accept (no-op). The runtime treats a
 * `null` inverse as a silent skip — acceptance just doesn't enter the
 * undo history.
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    identity_kind: InvitationIdentityKindEnum,
    identity_value: z.string().min(3).max(254),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'acceptInvitation' as const;

/**
 * Every role — including `restricted` — can run this. See the file-
 * level comment for why the gate is intentionally open here. The HTTP
 * boundary's identity-match preflight is the real security gate; the
 * server mutator additionally re-checks the DO pending_invites row to
 * guard against a race where the invitation was revoked between
 * preflight and commit.
 */
export const requiredRole: readonly AuthorizationRole[] =
    AuthorizationRoleEnum.options;

export const server: ServerMutator<Args> = (
    { listId, identity_kind, identity_value },
    { sql, nextVersion, accountId, timestamp_client }
) => {
    if (!accountId) {
        // The HTTP preflight rejects this before we get here, but the
        // mutator is the security boundary — re-assert.
        throw new BadMutationError(
            'acceptInvitation requires an authenticated account'
        );
    }
    const normalizedValue = normalizeIdentityValue(
        identity_kind,
        identity_value
    );

    // Re-read the live pending row from the DO. The HTTP preflight
    // checks D1, which is a projection; this read is authoritative.
    const invite = getPendingInvite(sql, {
        identity_kind,
        identity_value: normalizedValue,
    });
    if (!invite) {
        // Could be revoked, already accepted, or never existed. All
        // three surface to the client as `gone` per ADR 0005's
        // structured no-op posture.
        return { status: 'gone' };
    }

    const nowSeconds = Math.floor(
        (timestamp_client ?? new Date()).getTime() / 1000
    );
    if (invite.time_expires < nowSeconds) {
        // Lazy-expire on read — no cron sweep. The row stays in DO
        // storage until cascade-delete; the client gets a `gone`.
        return { status: 'gone' };
    }

    // Read the entity's current authorization_rules so we can splice
    // the acceptor into `authorized_accounts`.
    const rows = sql
        .exec(
            `SELECT authorization_rules FROM list_elements
             WHERE id = ?
               AND type IN (${ENTITY_ROW_TYPES_SQL_LIST})
               AND time_deleted IS NULL;`,
            listId
        )
        .toArray();
    const row = rows[0];
    if (!row) {
        // Entity was deleted between preflight and commit.
        return { status: 'gone' };
    }
    const currentRaw = row.authorization_rules;
    const current: AuthorizationRules =
        typeof currentRaw === 'string'
            ? JSON.parse(currentRaw)
            : (currentRaw as unknown as AuthorizationRules);

    // If the acceptor already has an explicit grant, the invite is a
    // no-op on rules — but we still tombstone the pending row (the
    // invitation is "consumed") so the D1 index can flip to accepted.
    const alreadyMember =
        current.authorized_accounts[accountId] !== undefined;

    if (!alreadyMember) {
        const updated: AuthorizationRules = {
            ...current,
            authorized_accounts: {
                ...current.authorized_accounts,
                [accountId]: { role: invite.role },
            },
            // First explicit grant promotes a `defaults` rules block to
            // `user`-set. Workspace-inherited blocks keep their tag.
            set_by: current.set_by === 'defaults' ? 'user' : current.set_by,
        };
        setEntityAuthorizationRules(sql, {
            entityId: listId,
            authorization_rules: updated,
            version: nextVersion,
        });
    }

    // Tombstone the pending invite — bumps version so the next pull
    // surfaces `op:'del'` to anyone (e.g. owners) cached on the
    // `pending_invites/*` keyspace.
    tombstonePendingInvite(sql, {
        identity_kind,
        identity_value: normalizedValue,
        nowSeconds,
        version: nextVersion,
    });

    // If the rules update branch ran, it already bumped the entity
    // version. If we skipped it (already-member), bump explicitly so
    // the pull diff still picks up the invite tombstone.
    if (alreadyMember) {
        try {
            setListVersion(sql, nextVersion);
        } catch (error) {
            console.warn('`acceptInvitation` setListVersion warned:', error);
        }
        return { status: 'stale' };
    }
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, identity_kind, identity_value },
    { accountId, timestamp_client }
) => {
    if (!accountId) return;
    const raw = await tx.get(listId);
    if (!raw) {
        // No local entity to optimistically update. This is the common
        // case for an invitee arriving via `/l/<id>?from_invite=1`: the
        // server has the entity but the invitee's pull is blocked by
        // their `restricted` role, so the local Replicache store is
        // empty. The server mutator does the real work; once it commits
        // and the invitee's role is promoted, the next pull populates
        // local state. Skip the optimistic update — there's nothing
        // useful to write — and let the push proceed.
        return;
    }
    const entity = raw as Record<string, unknown> & {
        version?: number;
        authorization_rules?: AuthorizationRules;
    };

    const normalizedValue =
        identity_kind === 'email'
            ? identity_value.trim().toLowerCase()
            : identity_value.trim();
    const inviteKey = `pending_invites/${normalizedValue}`;

    // Optimistic local: read the cached pending invite (if visible to
    // this client; the invitee won't have it but the inviter would)
    // and use its role; default to `viewer` when unknown so the
    // optimistic entity at least shows access happened.
    const inviteRaw = (await tx.get(inviteKey)) as unknown as
        | { role?: string }
        | undefined;
    const role = (inviteRaw?.role as AuthorizationRole | undefined) ?? 'viewer';

    const currentRules: AuthorizationRules = entity.authorization_rules ?? {
        authorized_accounts: {},
        default_role: 'restricted',
        set_by: 'defaults',
    };
    const updatedRules: AuthorizationRules = {
        ...currentRules,
        authorized_accounts: {
            ...currentRules.authorized_accounts,
            [accountId]: { role: role as never },
        },
        set_by: currentRules.set_by === 'defaults' ? 'user' : currentRules.set_by,
    };

    const ts = timestamp_client ?? new Date();
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            authorization_rules: updatedRules,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
    await tx.del(inviteKey);
};

/**
 * Intentionally not undoable. See file-level comment.
 */
export const inverse: Inverse<Args> = () => null;
