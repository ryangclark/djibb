import { z } from 'zod';

import { AuthorizationRulesSchema } from '../../auth/rules';
import { NotFoundError } from '../../errors';
import { ListSchema } from '..';
import { setEntityAuthorizationRules } from '../sql';
import { OWNER_ROLES, toStoredValue } from './_shared';
import type { ClientMutator, ServerMutator } from './_shared';

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
    { listId, authorization_rules },
    { sql, nextVersion }
) => {
    setEntityAuthorizationRules(sql, {
        entityId: listId,
        authorization_rules,
        version: nextVersion,
    });
};

export const client: ClientMutator<Args> = async (
    tx,
    { listId, authorization_rules },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) {
        throw new NotFoundError(`entity "${listId}" not found`);
    }
    const entity = raw as Record<string, unknown> & { version?: number };
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
