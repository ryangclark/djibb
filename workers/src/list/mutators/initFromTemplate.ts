import { z } from 'zod';

import type { AuthorizationRules } from '../../auth/rules';
import { ValidationError } from '../../errors';
import { createElement } from '../sql';
import { ListSchema, TemplateSchema } from '..';
import type { List, Template } from '..';
import { DEFAULT_LIST_TITLE } from '.';
import {
    EDIT_ROLES,
    MutationEnvelopeArgsSchema,
    toStoredValue,
} from './_shared';
import type {
    ClientMutator,
    Inverse,
    ServerMutator,
} from './_shared';

/**
 * Init a list from a template (a "fork").
 *
 * **Scope decision (A.8, intentional):** this PR only creates the
 * destination entity row with `forked_from_id` set, the template's
 * name and description carried over via args, and an empty
 * `child_element_refs`. **It does NOT copy template contents** (items
 * and groups under the template).
 *
 * Why deferred: full content copy is a DO-to-DO operation. Three
 * candidate shapes (worker pre-fetch, client pre-fetch + inline
 * payload, mutator-internal DO RPC requiring async ServerMutator)
 * each have meaningful trade-offs that warrant a design conversation.
 * Phase A is the substrate; the copy orchestration is properly its
 * own ADR-worthy decision and is being kicked.
 *
 * Today's behavior: `initFromTemplate` produces an empty list with
 * template lineage (`forked_from_id` populated). Contents can be
 * added via subsequent `createListItem` mutations as a separate
 * orchestration. The caller (UI fork flow) is responsible for any
 * copy.
 *
 * Friction-tier per ADR 0005 — list creation crosses a structural
 * threshold; the runtime (B.2) renders a confirm toast on Cmd+Z,
 * keyed on this mutator's wire name being in
 * `FRICTION_TIER_MUTATORS` (`_shared.ts`).
 */
export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    templateId: TemplateSchema.shape.id,
    workspaceId: ListSchema.shape.workspace_id,
    /** Carried from the source template by the caller. */
    name: z.string().max(200),
    description: z.string().max(10_000).optional(),
});

/**
 * Wire shape: as it arrives in a Replicache mutation, including
 * envelope metadata. Mirrors initList's wireArgsSchema pattern.
 */
export const wireArgsSchema = z.object({
    ...argsSchema.shape,
    ...MutationEnvelopeArgsSchema.shape,
});

export type Args = z.infer<typeof argsSchema>;
export type WireArgs = z.infer<typeof wireArgsSchema>;

export const name = 'initFromTemplate' as const;
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

    const entity: List = {
        id: args.listId,
        authorization_rules,
        child_element_refs: [],
        description: args.description,
        forked_from_id: args.templateId,
        name: args.name || DEFAULT_LIST_TITLE,
        slot: null,
        time_created: ts,
        time_deleted: null,
        time_updated: ts,
        type: 'list',
        workspace_id: args.workspaceId,
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

    const entity: List = {
        authorization_rules: authorizationRules,
        child_element_refs: [],
        description: args.description,
        forked_from_id: args.templateId,
        type: 'list',
        id: args.listId,
        name: args.name || DEFAULT_LIST_TITLE,
        slot: null,
        time_created: ts,
        time_deleted: null,
        time_updated: ts,
        version: 1,
        workspace_id: args.workspaceId,
    };

    const parseResult = ListSchema.safeParse(entity);
    if (!parseResult.success) {
        console.error(
            '`initFromTemplate()` entity validation error:',
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
 * Constructive inverse: archive the just-created list. Friction-tier
 * is enforced by the runtime via `FRICTION_TIER_MUTATORS`; the
 * inverse itself is a plain archiveList — undo of a fork removes the
 * entity, redo (Cmd+Shift+Z) re-creates it.
 */
export const inverse: Inverse<Args> = ({ listId }) => ({
    name: 'archiveList',
    args: { listId },
});
