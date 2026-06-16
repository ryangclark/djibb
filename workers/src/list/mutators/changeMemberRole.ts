import { z } from 'zod';

import { NotFoundError } from '@djibb/protocol/errors';
import { AccountRoleEnum, type AuthorizationRules } from '@djibb/protocol/auth/rules';
import { ENTITY_ROW_TYPES_SQL_LIST, ListSchema } from '@djibb/protocol/list';
import {
    assertSingleOwner,
    countOwners,
    OWNER_ROLES,
    parseStoredAuthorizationRules,
    toStoredValue,
} from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * ADR 0011 §Step 7: change a member's role on an entity. Upserts the
 * grant in `authorization_rules.authorized_accounts` — if the target
 * isn't already a member, this acts as a direct add (the primary path
 * is still invite → accept via ADR 0009, but the umbrella mutator
 * collapses "add" and "modify" into a single surface for the inverse
 * of `removeMember` to target).
 *
 * Preconditions (server-checked):
 *   - actor's role must be admin or owner (`requiredRole` gate).
 *   - role argument must be an `AccountRole` (the narrow membership-
 *     legal subset: admin, checker, editor, owner, viewer). The wider
 *     `AuthorizationRoleEnum` includes `ownerless` and `restricted`
 *     which don't belong on a specific account.
 *   - granting `owner` requires the actor to be the current owner —
 *     same gate as `transferOwnership`. Admins cannot mint owners.
 *   - the single-owner invariant must hold post-write. The mutator
 *     enforces this by demoting any existing owner to `admin` if the
 *     target is being promoted to owner (mirrors `transferOwnership`).
 *   - admins cannot touch an existing owner (no demote-the-owner via
 *     this surface; that goes through `transferOwnership`).
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    targetAccountId: z.string().min(1),
    role: AccountRoleEnum,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'changeMemberRole' as const;
export const requiredRole = OWNER_ROLES;

function readCurrentRules(
    sql: SqlStorage,
    entityId: string
): AuthorizationRules | null {
    const rows = sql
        .exec(
            `SELECT authorization_rules FROM list_elements
             WHERE id = ?
               AND type IN (${ENTITY_ROW_TYPES_SQL_LIST})
               AND time_deleted IS NULL;`,
            entityId
        )
        .toArray();
    const row = rows[0];
    if (!row) return null;
    return parseStoredAuthorizationRules(row.authorization_rules);
}

export const server: ServerMutator<Args> = (
    { listId, targetAccountId, role: newRole },
    { sql, store, role: actorRole, accountId, nextVersion }
) => {
    const current = readCurrentRules(sql, listId);
    if (!current) return { status: 'gone' };

    const target = current.authorized_accounts[targetAccountId];

    // Admins cannot touch an owner or mint a new one.
    if (
        actorRole !== 'owner' &&
        (target?.role === 'owner' || newRole === 'owner')
    ) {
        return { status: 'stale' };
    }

    // Promoting to owner requires the actor to be the current owner —
    // matches `transferOwnership`. Demote any existing owner to admin
    // in the same write to preserve the single-owner invariant.
    let nextAccounts: AuthorizationRules['authorized_accounts'];
    if (newRole === 'owner') {
        if (!accountId) return { status: 'gone' };
        if (target?.role === 'owner') return; // idempotent no-op
        // Demote whoever currently holds 'owner' (if anyone) and
        // promote the target.
        nextAccounts = {};
        for (const [aid, entry] of Object.entries(
            current.authorized_accounts
        )) {
            nextAccounts[aid] =
                entry.role === 'owner' ? { role: 'admin' } : entry;
        }
        nextAccounts[targetAccountId] = { role: 'owner' };
    } else {
        // Demoting the last owner is forbidden — same posture as
        // `removeMember`. Use `transferOwnership` to hand off first.
        if (target?.role === 'owner' && countOwners(current) <= 1) {
            return { status: 'stale' };
        }
        if (target?.role === newRole) return; // idempotent
        nextAccounts = {
            ...current.authorized_accounts,
            [targetAccountId]: { role: newRole },
        };
    }

    const updated: AuthorizationRules = {
        ...current,
        authorized_accounts: nextAccounts,
        // First explicit grant promotes a `defaults` rules block to
        // user-set; matches `acceptInvitation`'s posture.
        set_by: current.set_by === 'defaults' ? 'user' : current.set_by,
    };

    assertSingleOwner(updated);
    store.setEntityAuthorizationRules({
        entityId: listId,
        authorization_rules: updated,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, targetAccountId, role: newRole },
    { accountId, timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) throw new NotFoundError(`entity "${listId}" not found`);
    const entity = raw as Record<string, unknown> & {
        version?: number;
        authorization_rules?: AuthorizationRules;
    };
    const current = entity.authorization_rules;
    if (!current) return;

    let nextAccounts: AuthorizationRules['authorized_accounts'];
    if (newRole === 'owner') {
        if (!accountId) return;
        nextAccounts = {};
        for (const [aid, entry] of Object.entries(
            current.authorized_accounts
        )) {
            nextAccounts[aid] =
                entry.role === 'owner' ? { role: 'admin' } : entry;
        }
        nextAccounts[targetAccountId] = { role: 'owner' };
    } else {
        nextAccounts = {
            ...current.authorized_accounts,
            [targetAccountId]: { role: newRole },
        };
    }

    const updated: AuthorizationRules = {
        ...current,
        authorized_accounts: nextAccounts,
        set_by: current.set_by === 'defaults' ? 'user' : current.set_by,
    };

    const ts = timestamp_client ?? new Date();
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            authorization_rules: updated,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

export const capturePreState: CapturePreState<Args> = async (
    tx,
    { listId, targetAccountId }
) => {
    const raw = await tx.get(listId);
    if (!raw) return {};
    const entity = raw as Record<string, unknown> & {
        authorization_rules?: AuthorizationRules;
    };
    const priorRole =
        entity.authorization_rules?.authorized_accounts[targetAccountId]
            ?.role ?? null;
    return { priorRole };
};

/**
 * Inverse: restore the prior role, or remove the target if they weren't
 * a member before. Routes through `changeMemberRole` (self) for the
 * first case and `removeMember` for the second.
 */
export const inverse: Inverse<Args> = (args, preState) => {
    const priorRole = (preState as { priorRole?: string | null } | undefined)
        ?.priorRole;
    if (!priorRole) {
        return {
            name: 'removeMember',
            args: {
                listId: args.listId,
                targetAccountId: args.targetAccountId,
            },
        };
    }
    return {
        name,
        args: {
            listId: args.listId,
            targetAccountId: args.targetAccountId,
            role: priorRole,
        },
    };
};
