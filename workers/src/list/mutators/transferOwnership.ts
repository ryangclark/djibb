import { z } from 'zod';

import { AuthorizationRoleEnum } from '../../auth/rules';
import type { AuthorizationRules } from '../../auth/rules';
import { NotFoundError } from '../../errors';
import { ENTITY_ROW_TYPES_SQL_LIST, ListSchema } from '..';
import { setEntityAuthorizationRules } from '../sql';
import {
    assertSingleOwner,
    findOwnerAccountId,
    parseStoredAuthorizationRules,
    toStoredValue,
} from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * ADR 0011 §Decision C — atomically transfer the entity's principal
 * `'owner'` role to another account. The current owner becomes
 * `'admin'` (same powers, no longer the unique principal); the target
 * becomes `'owner'`. The swap preserves the single-owner invariant.
 *
 * Caller authorization: the role gate requires `'owner'`, but that
 * isn't strict enough on its own — an entity with multiple admins
 * would all pass. The server mutator additionally checks that
 * `ctx.accountId` matches the current owner; a mismatch surfaces
 * `{status: 'stale'}` so the runtime treats it like a CAS conflict
 * (someone else transferred first, or the caller's local state was
 * out of date).
 *
 * Recipient authorization: the target must already be an authorized
 * member of the entity (`{status: 'gone'}` otherwise). Because the
 * transfer is immediate and non-consensual, restricting it to existing
 * members is what keeps it from being an unwanted-ownership /
 * notification-spam vector — see the server mutator's guard.
 *
 * Not undoable. Returning `null` from `inverse` keeps the action out
 * of the undo history entirely. Reversal happens out-of-band: the new
 * owner can transfer back. Adding it to `FRICTION_TIER_MUTATORS` would
 * be the natural next move once the undo runtime supports friction
 * confirms without a paired inverse.
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    /**
     * Account ID that will become the new principal owner. Must not
     * equal the current owner; same-target is a no-op rather than an
     * error (clients may fire it from a stale view).
     */
    toAccountId: z.string().min(1),
    /**
     * Optional CAS guard. If supplied, the server checks that the
     * current owner matches `fromAccountId` and no-ops with `stale`
     * otherwise. Distinct from the caller-identity check (which uses
     * `ctx.accountId`) — `fromAccountId` lets a UI explicitly confirm
     * the version of reality it was operating on.
     */
    fromAccountId: z.string().min(1).optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'transferOwnership' as const;
/**
 * Only an `'owner'` can transfer. `'admin'` is intentionally excluded:
 * the principal role is the one the transfer mints, and we don't want
 * a non-principal admin to be able to redirect ownership.
 */
export const requiredRole = [AuthorizationRoleEnum.enum.owner] as const;

export const server: ServerMutator<Args> = (
    { listId, toAccountId, fromAccountId },
    { sql, nextVersion, accountId }
) => {
    if (!accountId) {
        // The role gate already requires `'owner'` which requires an
        // authenticated principal; defensive against a misconfigured
        // dispatch.
        return { status: 'gone' };
    }

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
    if (!row) return { status: 'gone' };

    const current = parseStoredAuthorizationRules(row.authorization_rules);

    const currentOwner = findOwnerAccountId(current);
    if (currentOwner === null) {
        // Ownerless entities have no principal to transfer. Promotion
        // from ownerless lives in a future "claim" mutator, not here.
        return { status: 'gone' };
    }

    // CAS pre-check: the caller must be the current owner, and (if
    // supplied) `fromAccountId` must agree.
    if (currentOwner !== accountId) return { status: 'stale' };
    if (fromAccountId !== undefined && fromAccountId !== currentOwner) {
        return { status: 'stale' };
    }

    // Same-target transfer is a no-op — useful when a client fires
    // from a stale-but-consistent view.
    if (toAccountId === currentOwner) return;

    // Recipient must already be an authorized member of this entity.
    // Ownership transfer is non-consensual by design (ADR 0011 §Decision
    // C — "transferred, never invited"), so the only thing keeping it
    // from being an unwanted-ownership / email-harassment vector is that
    // you can only hand ownership to someone who already has a
    // relationship with the entity. Members live in this entity's own
    // `authorization_rules`, so the check is local — no preflight/D1
    // needed (unlike `moveList`'s cross-entity destination check). A
    // non-member target reports `gone`: there's no such member to
    // promote. The UI only ever offers existing members; this guard
    // defends the boundary against a hand-crafted or buggy client.
    if (!current.authorized_accounts[toAccountId]) {
        return { status: 'gone' };
    }

    const updated: AuthorizationRules = {
        ...current,
        authorized_accounts: {
            ...current.authorized_accounts,
            // Demote outgoing owner to admin (same powers, no longer
            // the principal).
            [currentOwner]: { role: 'admin' },
            // Promote target to owner.
            [toAccountId]: { role: 'owner' },
        },
    };

    assertSingleOwner(updated);
    setEntityAuthorizationRules(sql, {
        entityId: listId,
        authorization_rules: updated,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, toAccountId, fromAccountId },
    { accountId, timestamp_client }
) => {
    if (!accountId) return;

    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`entity "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & {
        version?: number;
        authorization_rules?: AuthorizationRules;
    };
    const current = entity.authorization_rules;
    if (!current) return;

    const currentOwner = findOwnerAccountId(current);
    if (currentOwner === null) return;
    if (currentOwner !== accountId) return;
    if (fromAccountId !== undefined && fromAccountId !== currentOwner) {
        return;
    }
    if (toAccountId === currentOwner) return;
    // Mirror the server's recipient-must-be-a-member guard (see the
    // server mutator) so the optimistic local state matches what the
    // authority will accept.
    if (!current.authorized_accounts[toAccountId]) return;

    const updated: AuthorizationRules = {
        ...current,
        authorized_accounts: {
            ...current.authorized_accounts,
            [currentOwner]: { role: 'admin' },
            [toAccountId]: { role: 'owner' },
        },
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
 * Not undoable. Reversal is "the new owner transfers back," which
 * requires their participation and so doesn't belong in the original
 * caller's undo stack. See header comment.
 */
export const inverse: Inverse<Args> = () => null;
