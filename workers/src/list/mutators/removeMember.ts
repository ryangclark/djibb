import { z } from 'zod';

import { NotFoundError } from '../../errors';
import type { AuthorizationRules } from '@djibb/protocol/auth/rules';
import { ENTITY_ROW_TYPES_SQL_LIST, ListSchema } from '@djibb/protocol/list';
import { setEntityAuthorizationRules } from '../sql';
import {
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
 * ADR 0011 §Step 7: admin-initiated removal of a member from an
 * entity's `authorization_rules.authorized_accounts`. Symmetric to the
 * legacy `RemoveMember` HTTP endpoint, but routed through the DO so the
 * authoritative rules JSON and the `entity_memberships` projection stay
 * coherent in one commit.
 *
 * Preconditions (server-checked):
 *   - actor's role must be admin or owner (`requiredRole` gate).
 *   - target must exist in `authorized_accounts`.
 *   - cannot remove the last owner (the single-owner invariant allows
 *     zero owners, but losing the principal silently strips the entity
 *     of any "claim ownership" path; we require an explicit
 *     `transferOwnership` first).
 *   - admins cannot remove owners — the principal-vs-non-principal
 *     distinction lives at this gate, not at the DO sql layer.
 *
 * Constructive shape — no pre-state needed; the prior role is recovered
 * via `capturePreState` so the inverse can restore the exact grant.
 * Not in `FRICTION_TIER_MUTATORS` yet; revisit when the members UI
 * surfaces this action.
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    targetAccountId: z.string().min(1),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'removeMember' as const;
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
    { listId, targetAccountId },
    { sql, role, nextVersion }
) => {
    const current = readCurrentRules(sql, listId);
    if (!current) return { status: 'gone' };

    const target = current.authorized_accounts[targetAccountId];
    if (!target) {
        // Idempotent: removing a non-member is a no-op, not an error.
        return { status: 'stale' };
    }

    // Admins cannot remove owners; only an owner can demote the
    // principal (and only via `transferOwnership`, not removal).
    if (target.role === 'owner' && role !== 'owner') {
        return { status: 'stale' };
    }

    // Cannot remove the last owner — would leave the entity ownerless
    // with no recovery path through this mutator. Use `transferOwnership`
    // to hand the principal off first.
    if (target.role === 'owner' && countOwners(current) <= 1) {
        return { status: 'stale' };
    }

    const nextAccounts = { ...current.authorized_accounts };
    delete nextAccounts[targetAccountId];

    const updated: AuthorizationRules = {
        ...current,
        authorized_accounts: nextAccounts,
    };

    setEntityAuthorizationRules(sql, {
        entityId: listId,
        authorization_rules: updated,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, targetAccountId },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) throw new NotFoundError(`entity "${listId}" not found`);
    const entity = raw as Record<string, unknown> & {
        version?: number;
        authorization_rules?: AuthorizationRules;
    };
    const current = entity.authorization_rules;
    if (!current) return;
    if (!current.authorized_accounts[targetAccountId]) return;

    const nextAccounts = { ...current.authorized_accounts };
    delete nextAccounts[targetAccountId];
    const updated: AuthorizationRules = {
        ...current,
        authorized_accounts: nextAccounts,
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
 * Inverse: re-add the target with the role they had before removal.
 * Surfaced through `changeMemberRole` (the role-set mutator) — it
 * upserts the grant whether or not it was there before, which is the
 * shape we want here.
 *
 * Returns `null` when the target wasn't a member at forward-fire time
 * (nothing to undo) or when the rules block has changed shape in a way
 * we can't safely reverse.
 */
export const inverse: Inverse<Args> = (args, preState) => {
    const priorRole = (preState as { priorRole?: string | null } | undefined)
        ?.priorRole;
    if (!priorRole) return null;
    return {
        name: 'changeMemberRole',
        args: {
            listId: args.listId,
            targetAccountId: args.targetAccountId,
            role: priorRole,
        },
    };
};
