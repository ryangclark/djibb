import { z } from 'zod';

import type { AuthorizationRules } from '../../auth/rules';
import { ValidationError } from '../../errors';
import { createElement } from '../sql';
import { defaultSlugForId } from '../entity';
import { SlotEnum, WorkspaceEntitySchema } from '..';
import type { WorkspaceEntity } from '..';
import { DEFAULT_LIST_TITLE } from '.';
import {
    EDIT_ROLES,
    MutationEnvelopeArgsSchema,
    toStoredValue,
} from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';

/**
 * ADR 0011 §Step 5: mint a new Workspace as a DjibbList-substrate
 * entity. The caller becomes the sole owner; `default_role` is
 * `restricted` (workspace contents are private by default — sharing
 * comes via per-account grants in `authorized_accounts`, the same
 * machinery that gates lists and templates).
 *
 * Symmetric to `initList` but for `type: 'workspace'`. The DO that
 * receives the push is addressed by the workspace's own ID
 * (`w/<suffix>` prefix). `workspace_id` on the entity row is `null` —
 * a workspace is not nested under another workspace.
 *
 * `slot` is left null here. The `personal_workspace` slot is the
 * concern of step 6's signup flow; ordinary `createWorkspace` mints
 * a team workspace with no slot assignment.
 *
 * **Slug** defaults to the workspace ID's suffix (the nanoid that
 * already lives after the `w/` prefix). The default needs no UNIQUE
 * arbitration — the suffix is a fresh nanoid and cannot collide with
 * an existing workspace. User-customized slugs ride on top via
 * `setWorkspaceSlug`, which runs an in-DO preflight against the D1
 * `UNIQUE(type, slug)` index before its synchronous mutator commits
 * (ADR 0011 §Step 7b.5).
 */
export const argsSchema = z.object({
    workspaceId: WorkspaceEntitySchema.shape.id,
    name: z.string().trim().min(1).max(100),
    /**
     * Well-known slot to tag this workspace with. Server trusts the
     * caller; the singleton invariant (one `personal_workspace` per
     * account, one `inbox` per account, one `seed_pool` globally) is
     * enforced by the call site (signup flow for `personal_workspace`),
     * NOT by this mutator. A future "claim slot" surface with cross-DO
     * verification will tighten this (same request/result pattern slugs
     * will use). ADR 0011 §Step 6.
     *
     * Default `null` — ordinary user-driven `createWorkspace` produces
     * a team workspace with no slot.
     */
    slot: SlotEnum.nullable().optional(),
});

/**
 * Wire shape: as it arrives in a Replicache mutation, including
 * envelope metadata. Mirrors `initList`'s wireArgsSchema pattern.
 */
export const wireArgsSchema = z.object({
    ...argsSchema.shape,
    ...MutationEnvelopeArgsSchema.shape,
});

export type Args = z.infer<typeof argsSchema>;
export type WireArgs = z.infer<typeof wireArgsSchema>;

export const name = 'createWorkspace' as const;
/**
 * Permissive on purpose, same as `initList`: a fresh DO has no
 * `authorized_accounts`, so the caller's role resolves to
 * `ownerless`. Without `ownerless` in the gate, a workspace could
 * never be born.
 */
export const requiredRole = EDIT_ROLES;

export const server: ServerMutator<Args> = (
    args,
    { sql, accountId, timestamp_client }
) => {
    const ts = timestamp_client ?? new Date();

    const authorization_rules: AuthorizationRules = accountId
        ? {
              authorized_accounts: { [accountId]: { role: 'owner' } },
              default_role: 'restricted',
              set_by: 'user',
          }
        : {
              authorized_accounts: {},
              default_role: 'ownerless',
              set_by: 'defaults',
          };

    const entity: WorkspaceEntity = {
        id: args.workspaceId,
        authorization_rules,
        child_element_refs: [],
        forked_from_id: null,
        meta: null,
        name: args.name,
        slug: defaultSlugForId(args.workspaceId),
        slot: args.slot ?? null,
        time_created: ts,
        time_deleted: null,
        time_updated: ts,
        type: 'workspace',
        // A workspace entity has no parent workspace.
        workspace_id: null,
        version: 0,
    };

    createElement(sql, entity);
};

export const client: ClientMutator<Args> = async (
    tx,
    args,
    { accountId, timestamp_client }
) => {
    if (!(await tx.isEmpty())) return;

    const ts = timestamp_client ?? new Date();
    const authorizationRules: AuthorizationRules = accountId
        ? {
              authorized_accounts: { [accountId]: { role: 'owner' } },
              default_role: 'restricted',
              set_by: 'user',
          }
        : {
              authorized_accounts: {},
              default_role: 'ownerless',
              set_by: 'defaults',
          };

    const entity: WorkspaceEntity = {
        authorization_rules: authorizationRules,
        child_element_refs: [],
        forked_from_id: null,
        meta: null,
        type: 'workspace',
        id: args.workspaceId,
        name: args.name || DEFAULT_LIST_TITLE,
        slug: defaultSlugForId(args.workspaceId),
        slot: args.slot ?? null,
        time_created: ts,
        time_deleted: null,
        time_updated: ts,
        version: 1,
        workspace_id: null,
    };

    const parseResult = WorkspaceEntitySchema.safeParse(entity);
    if (!parseResult.success) {
        console.error(
            '`createWorkspace()` entity validation error:',
            z.prettifyError(parseResult.error)
        );
        throw new ValidationError();
    }

    await Promise.all([
        tx.set('m/auth_default_role', authorizationRules.default_role),
        tx.set(entity.id, toStoredValue(entity)),
    ]);
};

/**
 * Constructive inverse: undoing a workspace creation archives it.
 * Friction-tier per ADR 0005 — workspace creation crosses a far
 * larger structural threshold than list creation; the runtime
 * should render a confirm toast on Cmd+Z. (Workspace mutators are
 * not yet listed in `FRICTION_TIER_MUTATORS`; revisit when the UI
 * surface lands in step 9.)
 *
 * Returns `null` for now — `archiveWorkspace` is not implemented
 * yet (the workspace cascade-delete dispatcher is step 10 of
 * ADR 0011). Once that lands, swap the body to
 * `{ name: 'archiveWorkspace', args: { workspaceId } }`.
 */
export const inverse: Inverse<Args> = () => null;
