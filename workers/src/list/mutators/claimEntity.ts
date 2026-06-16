import { z } from 'zod';

import { AuthorizationRoleEnum } from '@djibb/protocol/auth/rules';
import type { AuthorizationRules } from '@djibb/protocol/auth/rules';
import { ENTITY_ROW_TYPES_SQL_LIST, ListSchema } from '..';
import { setEntityAuthorizationRules, setEntityWorkspaceId } from '../sql';
import {
    assertSingleOwner,
    findOwnerAccountId,
    parseStoredAuthorizationRules,
    toStoredValue,
} from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';

/**
 * Claim an ownerless entity — the "Adopt" half of the Minted List flow
 * (CONTEXT.md §Minted List). An anonymous homepage visitor mints a List
 * via `mintFromBlank` (ownerless: empty `authorized_accounts`,
 * `default_role: 'ownerless'`, null `workspace_id`); when they later
 * sign in, this promotes that same entity in place — no content merge,
 * because the minted id never changes. Identity is stable across the
 * auth boundary; only the authorization and workspace move.
 *
 * `transferOwnership` deliberately refuses ownerless entities ("Promotion
 * from ownerless lives in a future 'claim' mutator, not here") — this is
 * that mutator. It is the inverse situation: 0 → 1 owner rather than a
 * 1 → 1 swap.
 *
 * **Authorization is enforced in the body, not the gate.** An authed
 * caller resolves to the entity's `default_role` — `ownerless` — so the
 * role gate is `[ownerless]`. But an *anonymous* caller resolves to
 * `ownerless` too, so the gate alone can't tell them apart: the server
 * additionally requires `accountId` (mirroring `transferOwnership`'s
 * defensive `if (!accountId)` guard).
 *
 * **CAS-guarded.** Reading current rules and finding an owner means
 * someone claimed first — surface `{status: 'gone'}` so the runtime
 * treats it like a conflict. A same-account re-claim is an idempotent
 * no-op (the adopt-on-sign-in loop may fire more than once).
 *
 * Not undoable (`inverse → null`): "disown" is an out-of-band action,
 * like `transferOwnership`'s reversal. Stays off `FRICTION_TIER_MUTATORS`
 * for the same reason (that set needs a paired inverse).
 *
 * NOTE: this changes `authorization_rules` *and* `workspace_id`, both
 * projected to the D1 read index, so `'claimEntity'` MUST be in the DO's
 * `ENTITY_METADATA_MUTATORS` — otherwise the post-commit snapshot never
 * emits and the next pull 404s (the bug `mintFromBlank` hit).
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    /**
     * Personal workspace to file the claimed entity under. Optional: if
     * the claimer has no active workspace yet, the entity stays
     * workspace-less and the auth promotion still happens.
     */
    workspaceId: ListSchema.shape.workspace_id.optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'claimEntity' as const;
/**
 * Only `ownerless` can claim — an entity that already has a principal is
 * claimed via nothing (it's owned). The body's `accountId` check is what
 * separates an authed claimer from an anonymous passer-by, since both
 * resolve to `ownerless` on the entity.
 */
export const requiredRole = [AuthorizationRoleEnum.enum.ownerless] as const;

export const server: ServerMutator<Args> = (
    { listId, workspaceId },
    { sql, nextVersion, accountId }
) => {
    if (!accountId) {
        // Anonymous callers also resolve to `ownerless`; there's no
        // principal to install. Defensive — the UI never fires claim
        // without a session.
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
    if (currentOwner !== null) {
        // Already owned. A re-claim by the same account is a no-op (the
        // adopt loop is idempotent); anyone else lost the race.
        return currentOwner === accountId ? undefined : { status: 'gone' };
    }

    const updated: AuthorizationRules = {
        ...current,
        authorized_accounts: {
            ...current.authorized_accounts,
            [accountId]: { role: 'owner' },
        },
        // No longer anonymous-editable; the new owner controls access.
        default_role: 'restricted',
        set_by: 'user',
    };

    assertSingleOwner(updated);
    setEntityAuthorizationRules(sql, {
        entityId: listId,
        authorization_rules: updated,
        version: nextVersion,
    });

    // File it under the claimer's personal workspace, if they have one.
    // Same version — both UPDATEs touch disjoint columns of one row.
    if (workspaceId) {
        setEntityWorkspaceId(sql, {
            entityId: listId,
            workspace_id: workspaceId,
            version: nextVersion,
        });
    }
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, workspaceId },
    { accountId, timestamp_client }
) => {
    if (!accountId) return;

    const raw = await tx.get(listId);
    if (!raw) {
        // Adopt-on-sign-in fires claim against entities this fresh client
        // hasn't pulled yet, so there's no local row to optimistically
        // update. Skip the optimistic write — the mutation still queues
        // and the authoritative server mutator performs the claim; the
        // subsequent pull reconciles local state. (Unlike
        // `transferOwnership`/`setListAuthRules`, which act on a list the
        // caller is already viewing and so treat a missing row as a bug.)
        return;
    }
    const entity = raw as Record<string, unknown> & {
        version?: number;
        workspace_id?: string | null;
        authorization_rules?: AuthorizationRules;
    };
    const current = entity.authorization_rules;
    if (!current) return;

    const currentOwner = findOwnerAccountId(current);
    if (currentOwner !== null) return; // already owned — no-op (mirror server)

    const updated: AuthorizationRules = {
        ...current,
        authorized_accounts: {
            ...current.authorized_accounts,
            [accountId]: { role: 'owner' },
        },
        default_role: 'restricted',
        set_by: 'user',
    };

    const ts = timestamp_client ?? new Date();
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            authorization_rules: updated,
            workspace_id: workspaceId ?? entity.workspace_id ?? null,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

/**
 * Not undoable. Reversal ("disown" back to ownerless) is an out-of-band
 * action, not something the claimer's undo stack should silently offer —
 * same posture as `transferOwnership`.
 */
export const inverse: Inverse<Args> = () => null;
