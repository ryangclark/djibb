import { z } from 'zod';

import type { AuthorizationRules } from '../../auth/rules';
import { ValidationError } from '../../errors';
import { createElement, insertListGroup, insertListItem } from '../sql';
import {
    ListGroupSchema,
    ListItemSchema,
    ListSchema,
    TemplateSchema,
} from '..';
import type { List } from '..';
import { DEFAULT_LIST_TITLE } from '.';
import {
    EDIT_ROLES,
    MutationEnvelopeArgsSchema,
    toStoredValue,
} from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';

/**
 * Mint a real, non-empty List from a Blank Template — the homepage
 * "Minted List" path (CONTEXT.md §Minted List / §Seed Pool). Unlike
 * `initFromTemplate` (which deliberately creates an *empty* shell and
 * defers content-copy), `mintFromBlank` copies the Blank's groups and
 * items into the new DO in a single mutation.
 *
 * **Copy mechanism — hybrid, phase 1a (inline).** The full element
 * tree arrives inline in `args` (groups + items, with client-generated
 * ids and parent refs, so the optimistic client write and the
 * authoritative server write produce identical ids — a Replicache
 * requirement). The homepage already pulled the Blank to render its
 * preview, so the content is in hand at engage time; no DO-to-DO read
 * is needed here.
 *
 * **Phase 1b (server-authoritative verify)** layers on top *without
 * touching this mutator*: a `_handlePush` preflight (the
 * `PREFLIGHTED_MUTATORS` async seam) reads the real Blank DO and
 * verifies the submitted content faithfully matches it via an
 * id-independent signature (`./fork.ts`). Match → this mutator runs as
 * written; mismatch → skip-and-ack. Verifying rather than overwriting
 * keeps the client's optimistic ids (no churn) while still making
 * `forked_from_id` authoritative for content-at-birth — a client cannot
 * mint a List claiming a Blank whose content it didn't faithfully copy.
 *
 * Ownerless by default: when `accountId` is null (an unauthed homepage
 * visitor) the minted List is `default_role: 'ownerless'` with an empty
 * `authorized_accounts` and a null `workspace_id`. Sign-in adopts it in
 * place (separate flow) into the personal workspace.
 */

const ChildGroupSchema = ListGroupSchema.extend({ version: z.number() });
const ChildItemSchema = ListItemSchema.extend({ version: z.number() });

export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    workspaceId: ListSchema.shape.workspace_id,
    /** The Blank this List is forked from; becomes `forked_from_id`. */
    blankId: TemplateSchema.shape.id,
    name: z.string().max(200),
    description: z.string().max(10_000).optional(),
    /** Top-level child order for the List entity (group + loose-item ids). */
    childElementRefs: z.array(z.string()),
    /** Group rows to copy in; each `parent_element_ref` is `listId`. */
    groups: z.array(ChildGroupSchema),
    /** Item rows to copy in; `parent_element_ref` is a group id or `listId`. */
    items: z.array(ChildItemSchema),
});

/**
 * Wire shape: args plus the envelope metadata Replicache crams into
 * `args`. Mirrors `initFromTemplate`'s `wireArgsSchema`.
 */
export const wireArgsSchema = z.object({
    ...argsSchema.shape,
    ...MutationEnvelopeArgsSchema.shape,
});

export type Args = z.infer<typeof argsSchema>;
export type WireArgs = z.infer<typeof wireArgsSchema>;

export const name = 'mintFromBlank' as const;
export const requiredRole = EDIT_ROLES;

function rulesFor(accountId: string | null): AuthorizationRules {
    return accountId
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
}

export const server: ServerMutator<Args> = (args, { sql, accountId, nextVersion, timestamp_client }) => {
    const ts = timestamp_client ?? new Date();

    const entity: List = {
        id: args.listId,
        authorization_rules: rulesFor(accountId),
        child_element_refs: args.childElementRefs,
        description: args.description,
        forked_from_id: args.blankId,
        meta: null,
        name: args.name || DEFAULT_LIST_TITLE,
        slot: null,
        time_created: ts,
        time_deleted: null,
        time_updated: ts,
        type: 'list',
        workspace_id: args.workspaceId,
        version: 0,
    };

    // Entity first (createElement guards entity-row types), then the
    // copied children at this mutation's version so a fresh pull
    // (`version > -1`) returns the whole tree.
    createElement(sql, entity);
    for (const group of args.groups) {
        insertListGroup(sql, { ...group, version: nextVersion });
    }
    for (const item of args.items) {
        insertListItem(sql, { ...item, version: nextVersion });
    }
};

export const client: ClientMutator<Args> = async (tx, args, { accountId, timestamp_client }) => {
    if (!(await tx.isEmpty())) return;

    const ts = timestamp_client ?? new Date();
    const authorizationRules = rulesFor(accountId);

    const entity: List = {
        authorization_rules: authorizationRules,
        child_element_refs: args.childElementRefs,
        description: args.description,
        forked_from_id: args.blankId,
        meta: null,
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
            '`mintFromBlank()` entity validation error:',
            z.prettifyError(parseResult.error)
        );
        throw new ValidationError();
    }

    await Promise.all([
        tx.set('m/auth_default_role', authorizationRules.default_role),
        tx.set(entity.id, toStoredValue(entity)),
        ...args.groups.map(g => tx.set(g.id, toStoredValue(g))),
        ...args.items.map(i => tx.set(i.id, toStoredValue(i))),
    ]);
};

/**
 * Constructive inverse: archive the just-minted List. The id is in
 * `args`, so no `capturePreState`. Friction-tier (structural create) is
 * enforced via `FRICTION_TIER_MUTATORS`, matching `initFromTemplate`.
 */
export const inverse: Inverse<Args> = ({ listId }) => ({
    name: 'archiveList',
    args: { listId },
});
