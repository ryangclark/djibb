import { z } from 'zod';

import type { AuthorizationRules } from '../../auth/rules';
import { ValidationError } from '../../errors';
import { IdTypes } from '../../id';
import { createElement } from '../sql';
import { ListSchema, TemplateSchema } from '..';
import type { List, Template } from '..';
import { DEFAULT_LIST_TITLE } from '.';
import {
    EDIT_ROLES,
    MutationEnvelopeArgsSchema,
    toStoredValue,
} from './_shared';
import type { ClientMutator, ServerMutator } from './_shared';

export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    workspaceId: ListSchema.shape.workspace_id,
});

/**
 * Wire shape: the args object as it arrives in a Replicache mutation,
 * including envelope metadata (`accountId`, `timestamp_client`). The
 * worker parses this during init reconciliation; the DO mutator only
 * sees body args via dispatch.
 */
export const wireArgsSchema = z.object({
    ...argsSchema.shape,
    ...MutationEnvelopeArgsSchema.shape,
});

export type Args = z.infer<typeof argsSchema>;
export type WireArgs = z.infer<typeof wireArgsSchema>;

export const name = 'initList' as const;
export const requiredRole = EDIT_ROLES;

/**
 * Server-side init: writes the full entity row to the DO sql. Per ADR
 * 0003 the DO is authoritative for every entity field. The worker still
 * resolves auth rules from D1 on the hot path, but D1 is now a derived
 * read index emitted by the DO post-commit, not the source of truth.
 */
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

    // Same mutator initializes both Lists and Templates; the entity
    // type comes from the ID prefix. The worker's routing already
    // rejects mismatched prefixes against the wrong endpoint.
    const isTemplate = args.listId.startsWith(`${IdTypes.template}/`);
    const entity: List | Template = {
        id: args.listId,
        authorization_rules,
        child_element_refs: [],
        forked_from_id: null,
        name: DEFAULT_LIST_TITLE,
        time_created: ts,
        time_deleted: null,
        time_updated: ts,
        type: isTemplate ? 'template' : 'list',
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

    // Mirror the server mutator: derive entity type from the ID prefix
    // so a template-page init writes `type: 'template'` instead of the
    // wrong `type: 'list'`. Without this, scans by prefix `t/` produce
    // values that fail TemplateSchema parsing (type mismatch) and the
    // entity becomes invisible to downstream optimistic mutators.
    const isTemplate = args.listId.startsWith(`${IdTypes.template}/`);
    const entity: List | Template = {
        authorization_rules: authorizationRules,
        child_element_refs: [],
        forked_from_id: null,
        type: isTemplate ? 'template' : 'list',
        id: args.listId,
        name: DEFAULT_LIST_TITLE,
        time_created: ts,
        time_deleted: null,
        time_updated: ts,
        version: 1,
        workspace_id: args.workspaceId,
    };

    const schema = isTemplate ? TemplateSchema : ListSchema;
    const parseResult = schema.safeParse(entity);
    if (!parseResult.success) {
        console.error(
            '`initList()` entity validation error:',
            z.prettifyError(parseResult.error)
        );
        throw new ValidationError();
    }

    await Promise.all([
        tx.set('m/auth_default_role', authorizationRules.default_role),
        tx.set(entity.id, toStoredValue(entity)),
    ]);
};
