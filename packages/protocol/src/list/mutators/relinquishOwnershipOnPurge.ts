import { z } from 'zod';

import { ID_LENGTH, IdTypes } from '@djibb/protocol/id';
import {
    parseStoredAuthorizationRules,
    relinquishOwnership,
    SYSTEM_ROLES,
    toStoredValue,
} from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';
import type { AuthorizationRules } from '@djibb/protocol/auth/rules';

/**
 * Account-deletion Phase 2 (GH #64): relinquish a purged account's
 * ownership of a shared List/Template.
 *
 * When an account is hard-purged past its `time_deleted` grace window
 * (`auth/d1.ts` `PurgeTombstonedAccounts` → `auth/purge.ts`), any entity
 * it still principal-`'owner'`s must not be left pointing at a
 * scrubbed/absent identity. This mutator rewrites the entity's
 * `authorization_rules` to either force-transfer ownership to the
 * most-senior remaining member or, when no eligible member remains,
 * orphan the entity to `default_role: 'ownerless'` — and in every case
 * removes the departing account from `authorized_accounts`. The pure
 * decision lives in `relinquishOwnership` so this server mutator, the
 * client mirror below, and the sweep tests all agree.
 *
 * System-only (`requiredRole: SYSTEM_ROLES`, ADR 0011 §Step 10a.3): it is
 * driven by the auth worker via a synthetic-client push
 * (`clientGroupID: cg_purge:<accountId>`, `authorizedRole: 'system'`),
 * exactly like the workspace cascade mutators. No session or bearer
 * credential can forge `'system'`, so ownership can never be silently
 * seized by a caller pretending to purge someone.
 *
 * Terminal / non-undoable (`TERMINAL_MUTATORS`, `inverse: () => null`):
 * the departing identity is being erased, so there is no principal to
 * transfer back to. A within-grace restore un-tombstones the account
 * *before* purge; once purge has run this mutator, the account is gone
 * for good and so is its ownership.
 */

const LIST_ID_LENGTH = ID_LENGTH + IdTypes.list.length + 1;
const TEMPLATE_ID_LENGTH = ID_LENGTH + IdTypes.template.length + 1;

const ListOrTemplateIdSchema = z
    .string()
    .refine(
        id =>
            (id.startsWith(`${IdTypes.list}/`) &&
                id.length === LIST_ID_LENGTH) ||
            (id.startsWith(`${IdTypes.template}/`) &&
                id.length === TEMPLATE_ID_LENGTH),
        { message: 'relinquish target must be a list or template id' }
    );

export const argsSchema = z.object({
    listId: ListOrTemplateIdSchema,
    /** The account being purged — the departing owner. */
    departingAccountId: z.string().min(1),
});

export type Args = z.infer<typeof argsSchema>;

export const name = 'relinquishOwnershipOnPurge' as const;
export const requiredRole = SYSTEM_ROLES;

export const server: ServerMutator<Args> = (
    { listId, departingAccountId },
    { store, nextVersion }
) => {
    const row = store.getLiveEntityCasRow(listId);
    // Idempotent against a retry that already ran, or a stale
    // `entity_memberships` projection pointing at a now-gone entity.
    if (!row) return { status: 'gone' };

    const current = parseStoredAuthorizationRules(row.authorization_rules);
    const updated = relinquishOwnership(current, departingAccountId);

    // Account wasn't a member (projection lag) — nothing to write.
    if (updated === current) return;

    store.setEntityAuthorizationRules({
        entityId: listId,
        authorization_rules: updated,
        version: nextVersion,
    });
};

/**
 * Client mirror. The purge driver is not a Replicache client (the
 * synthetic `cg_purge:` clientID has no local cache), so nothing
 * consumes this for optimistic UI — connected human clients pick the
 * rules change up through their normal pull. It exists to satisfy the
 * registry contract and to keep a stray local invocation (test fixture,
 * replay) writing the same post-image as the server. Mirrors
 * `cascadeArchiveList`'s client shape.
 */
export const client: ClientMutator<Args> = async (
    tx,
    { listId, departingAccountId },
    { timestamp_client }
) => {
    const raw = await tx.get(listId);
    if (!raw) return;

    const entity = raw as Record<string, unknown> & {
        version?: number;
        authorization_rules?: AuthorizationRules;
    };
    const current = entity.authorization_rules;
    if (!current) return;

    const updated = relinquishOwnership(current, departingAccountId);
    if (updated === current) return;

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
 * Not undoable. See file header — the owning identity is being erased,
 * so there is no principal to transfer ownership back to.
 */
export const inverse: Inverse<Args> = () => null;
