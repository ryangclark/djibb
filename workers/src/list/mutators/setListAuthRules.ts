import { z } from 'zod';

import { AuthorizationRulesSchema } from '@djibb/protocol/auth/rules';
import { NotFoundError } from '../../errors';
import { ENTITY_ROW_TYPES_SQL_LIST, ListSchema } from '@djibb/protocol/list';
import { setEntityAuthorizationRules } from '../sql';
import { assertSingleOwner, OWNER_ROLES, toStoredValue } from './_shared';
import type {
    CapturePreState,
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * Whole-replace of the entity's authorization_rules. The simpler
 * primitive — field-level deltas (e.g. "add this account as editor")
 * can be added later as separate mutators if the UI needs them.
 *
 * No "do not lock yourself out" guard. The UI is responsible for
 * preventing nonsensical rules (e.g. removing the only owner). If
 * bricked, the list is recoverable via direct DO sql edit. Worth
 * adding a server-side guard later — TODO.
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    authorization_rules: AuthorizationRulesSchema,
    /**
     * Narrow set-family CAS. Whole-object equality on
     * `authorization_rules`. Friction-tier mutator — undo prompts a
     * confirm toast (ADR 0005 §"Friction tiers"); the CAS protects
     * against another admin changing rules between forward and undo.
     */
    expected: z
        .object({
            authorization_rules: AuthorizationRulesSchema,
        })
        .strict()
        .optional(),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'setListAuthRules' as const;
/**
 * Tighter than EDIT_ROLES — only admin or owner can re-grant access.
 * Editors and checkers can mutate list state but cannot change who
 * else gets in. `ownerless` is excluded by design; claim flow is
 * separate (and yet-unbuilt).
 */
export const requiredRole = OWNER_ROLES;

export const server: ServerMutator<Args> = (
    { listId, authorization_rules, expected },
    { sql, nextVersion }
) => {
    // ADR 0011 §Decision C: at most one principal `'owner'` per entity.
    // Non-principal collaborators with the same powers go through the
    // `'admin'` role; ownership is transferable via `transferOwnership`.
    assertSingleOwner(authorization_rules);

    if (expected?.authorization_rules !== undefined) {
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
        const currentRaw = row.authorization_rules;
        const current =
            typeof currentRaw === 'string' ? JSON.parse(currentRaw) : currentRaw;
        if (
            JSON.stringify(current) !==
            JSON.stringify(expected.authorization_rules)
        ) {
            return { status: 'stale' };
        }
    }
    setEntityAuthorizationRules(sql, {
        entityId: listId,
        authorization_rules,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, authorization_rules, expected },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`entity "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & { version?: number };

    if (expected?.authorization_rules !== undefined) {
        if (
            JSON.stringify(entity.authorization_rules) !==
            JSON.stringify(expected.authorization_rules)
        ) {
            return;
        }
    }

    const ts = timestamp_client ?? new Date();
    await tx.set(
        listId,
        toStoredValue({
            ...entity,
            authorization_rules,
            time_updated: ts.toISOString(),
            version: (entity.version ?? 0) + 1,
        })
    );
};

export const capturePreState: CapturePreState<Args> = async (
    tx,
    { listId }
) => {
    const raw = await tx.get(listId);
    if (!raw) return {};
    const entity = raw as Record<string, unknown>;
    return { authorization_rules: entity.authorization_rules };
};

export const inverse: Inverse<Args> = (args, preState) => {
    if (!preState || preState.authorization_rules === undefined) return null;
    return {
        name,
        args: {
            listId: args.listId,
            authorization_rules: preState.authorization_rules,
            expected: { authorization_rules: args.authorization_rules },
        },
    };
};
