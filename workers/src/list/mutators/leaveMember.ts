import { z } from 'zod';

import {
    AuthorizationRoleEnum,
    type AuthorizationRole,
    type AuthorizationRules,
} from '../../auth/rules';
import { NotFoundError } from '../../errors';
import { ENTITY_ROW_TYPES_SQL_LIST, ListSchema, isEntityRowType } from '..';
import { setEntityAuthorizationRules } from '../sql';
import { countOwners, toStoredValue } from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * ADR 0011 §Step 7: actor removes themselves from an entity's
 * `authorization_rules.authorized_accounts`. The shape mirrors
 * `removeMember` but the target is always `ctx.accountId`, so no
 * `targetAccountId` arg.
 *
 * Special role surface. The mutator's `requiredRole` covers every
 * `AuthorizationRole` because the action is "remove my own grant" —
 * any account with any grant should be able to drop it. The gate that
 * matters is "actor must have a grant on this entity," enforced
 * implicitly by the SQL lookup.
 *
 * Preconditions (server-checked):
 *   - actor must have an entry in `authorized_accounts`.
 *   - actor cannot be the last owner — `transferOwnership` first.
 *   - entity must not be `slot='personal_workspace'` (no escape hatch
 *     from your own workspace; it'd orphan all your contents).
 *
 * Not undoable. Returning `null` from `inverse` keeps "leave" out of
 * the undo history — re-joining requires an invite, not a button.
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'leaveMember' as const;

/**
 * Every role can run this — including `restricted`. See the file-level
 * comment for why the gate is intentionally open.
 */
export const requiredRole: readonly AuthorizationRole[] =
    AuthorizationRoleEnum.options;

export const server: ServerMutator<Args> = (
    { listId },
    { sql, accountId, nextVersion }
) => {
    if (!accountId) return { status: 'gone' };

    const rows = sql
        .exec(
            `SELECT type, slot, authorization_rules FROM list_elements
             WHERE id = ?
               AND type IN (${ENTITY_ROW_TYPES_SQL_LIST})
               AND time_deleted IS NULL;`,
            listId
        )
        .toArray();
    const row = rows[0];
    if (!row || !isEntityRowType(row.type as string)) {
        return { status: 'gone' };
    }
    if (row.slot === 'personal_workspace') {
        // Cannot leave your own personal workspace — orphans every
        // entity inside it. The legacy `LeaveWorkspace` had the same
        // guard against `is_personal`.
        return { status: 'stale' };
    }

    const raw = row.authorization_rules;
    const current: AuthorizationRules =
        typeof raw === 'string'
            ? JSON.parse(raw)
            : (raw as unknown as AuthorizationRules);

    const self = current.authorized_accounts[accountId];
    if (!self) {
        // Not a member — idempotent no-op.
        return { status: 'stale' };
    }
    if (self.role === 'owner' && countOwners(current) <= 1) {
        // Last owner; transfer first.
        return { status: 'stale' };
    }

    const nextAccounts = { ...current.authorized_accounts };
    delete nextAccounts[accountId];

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
    { listId },
    { accountId, timestamp_client }
) => {
    if (!accountId) return;
    const raw = await tx.get(listId);
    if (!raw) throw new NotFoundError(`entity "${listId}" not found`);
    const entity = raw as Record<string, unknown> & {
        version?: number;
        slot?: string | null;
        authorization_rules?: AuthorizationRules;
    };
    if (entity.slot === 'personal_workspace') return;
    const current = entity.authorization_rules;
    if (!current) return;
    if (!current.authorized_accounts[accountId]) return;

    const nextAccounts = { ...current.authorized_accounts };
    delete nextAccounts[accountId];
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

/**
 * Not undoable. Re-joining requires an invite — leaving is a one-way
 * step from the actor's perspective. Same posture as `acceptInvitation`
 * and `transferOwnership`.
 */
export const inverse: Inverse<Args> = () => null;
