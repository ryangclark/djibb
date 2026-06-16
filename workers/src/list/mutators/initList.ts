import { z } from 'zod';

import type { AuthorizationRules } from '@djibb/protocol/auth/rules';
import { DefaultRoleEnum } from '@djibb/protocol/auth/rules';
import { ValidationError } from '@djibb/protocol/errors';
import { IdTypes } from '@djibb/protocol/id';
import {
    ListGroupSchema,
    ListItemSchema,
    ListSchema,
    SlotEnum,
    TemplateSchema,
} from '@djibb/protocol/list';
import type { List, Template } from '@djibb/protocol/list';
import { DEFAULT_LIST_TITLE } from '.';
import {
    EDIT_ROLES,
    MutationEnvelopeArgsSchema,
    toStoredValue,
} from './_shared';
import type { ClientMutator, Inverse, ServerMutator } from './_shared';

/**
 * Create a top-level entity — a List or a Template; the same mutator
 * serves both because a Template *is* a List (same DO, same machinery),
 * with the concrete type derived from the id prefix (`l/` vs `t/`).
 *
 * **Empty by default, content-capable on request.** With only `listId`
 * + `workspaceId` it writes an empty shell (the original behavior — every
 * existing caller keeps working untouched). When the optional content
 * fields are present (`name`, `description`, `childElementRefs`, `groups`,
 * `items`) it writes the full element tree in the same mutation, like a
 * one-shot import. This is what lets `djibb promote` mint a content-ful
 * Blank Template in a single push (Phase 2 / CONTEXT.md §Seed Pool).
 *
 * **Slot + default-role overrides.** `slot` tags a well-known singleton
 * (the global `seed_pool` List); `defaultRole` overrides the role an
 * unlisted reader gets — a `viewer` Blank is publicly readable but not
 * editable. Both are optional and default to today's behavior.
 *
 * NOTE (deferred auth): `slot` and `defaultRole` are client-settable
 * here, which is a squat/spam surface — an anonymous caller could claim
 * the global `seed_pool` slot or mint `viewer` entities at will. This
 * matches the project's acknowledged "unauthenticated at first, lock
 * down later" posture for the Seed Pool; a server-side guard (e.g.
 * `slot: 'seed_pool'` only from a system/admin context) lands when the
 * holding pen moves to prod, without changing this wire shape.
 */

const ChildGroupSchema = ListGroupSchema.extend({ version: z.number() });
const ChildItemSchema = ListItemSchema.extend({ version: z.number() });

export const argsSchema = z.object({
    listId: ListSchema.shape.id,
    workspaceId: ListSchema.shape.workspace_id,

    // --- optional content (Phase 2); absent => empty shell as before ---
    name: z.string().max(200).optional(),
    description: z.string().max(10_000).optional(),
    /** Top-level child order for the entity (group + loose-item ids). */
    childElementRefs: z.array(z.string()).optional(),
    /** Group rows to write in; each `parent_element_ref` is `listId`. */
    groups: z.array(ChildGroupSchema).optional(),
    /** Item rows to write in; `parent_element_ref` is a group id or `listId`. */
    items: z.array(ChildItemSchema).optional(),

    // --- optional entity metadata (Phase 2) ---
    /** Well-known slot, e.g. `'seed_pool'`. Defaults to null (ordinary). */
    slot: SlotEnum.nullable().optional(),
    /** Override the unlisted-reader role, e.g. `'viewer'` for a Blank. */
    defaultRole: DefaultRoleEnum.optional(),
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
 * Build the entity's auth rules. An authed creator becomes `owner`; an
 * anonymous one creates an ownerless entity. `defaultRole`, when given,
 * overrides the role an unlisted reader resolves to (e.g. `viewer`).
 */
function rulesFor(
    accountId: string | null,
    defaultRole: Args['defaultRole']
): AuthorizationRules {
    return accountId
        ? {
              authorized_accounts: { [accountId]: { role: 'owner' } },
              default_role: defaultRole ?? 'restricted',
              set_by: 'user',
          }
        : {
              authorized_accounts: {},
              default_role: defaultRole ?? 'ownerless',
              set_by: 'defaults',
          };
}

/**
 * Server-side init: writes the full entity row to the DO sql. Per ADR
 * 0003 the DO is authoritative for every entity field. The worker still
 * resolves auth rules from D1 on the hot path, but D1 is now a derived
 * read index emitted by the DO post-commit, not the source of truth.
 */
export const server: ServerMutator<Args> = (
    args,
    { sql, store, accountId, nextVersion, timestamp_client }
) => {
    const ts = timestamp_client ?? new Date();

    // Same mutator initializes both Lists and Templates; the entity
    // type comes from the ID prefix. The worker's routing already
    // rejects mismatched prefixes against the wrong endpoint.
    const isTemplate = args.listId.startsWith(`${IdTypes.template}/`);
    const entity: List | Template = {
        id: args.listId,
        authorization_rules: rulesFor(accountId, args.defaultRole),
        child_element_refs: args.childElementRefs ?? [],
        description: args.description,
        forked_from_id: null,
        meta: null,
        name: args.name || DEFAULT_LIST_TITLE,
        slot: args.slot ?? null,
        time_created: ts,
        time_deleted: null,
        time_updated: ts,
        type: isTemplate ? 'template' : 'list',
        workspace_id: args.workspaceId,
        version: 0,
    };

    // Entity first (createElement guards entity-row types), then any
    // content children at this mutation's version so a fresh pull
    // (`version > -1`) returns the whole tree.
    store.createElement(entity);
    for (const group of args.groups ?? []) {
        store.insertListGroup({ ...group, version: nextVersion });
    }
    for (const item of args.items ?? []) {
        store.insertListItem({ ...item, version: nextVersion });
    }
};

export const client: ClientMutator<Args> = async (
    tx,
    args,
    { accountId, timestamp_client }
) => {
    if (!(await tx.isEmpty())) return;

    const ts = timestamp_client ?? new Date();
    const authorizationRules = rulesFor(accountId, args.defaultRole);

    // Mirror the server mutator: derive entity type from the ID prefix
    // so a template-page init writes `type: 'template'` instead of the
    // wrong `type: 'list'`. Without this, scans by prefix `t/` produce
    // values that fail TemplateSchema parsing (type mismatch) and the
    // entity becomes invisible to downstream optimistic mutators.
    const isTemplate = args.listId.startsWith(`${IdTypes.template}/`);
    const entity: List | Template = {
        authorization_rules: authorizationRules,
        child_element_refs: args.childElementRefs ?? [],
        description: args.description,
        forked_from_id: null,
        meta: null,
        type: isTemplate ? 'template' : 'list',
        id: args.listId,
        name: args.name || DEFAULT_LIST_TITLE,
        slot: args.slot ?? null,
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
        ...(args.groups ?? []).map(g => tx.set(g.id, toStoredValue(g))),
        ...(args.items ?? []).map(i => tx.set(i.id, toStoredValue(i))),
    ]);
};

/**
 * Constructive inverse: the inverse of "create the list" is
 * "archive the list." Friction-tier per ADR 0005 — list creation
 * crosses a structural threshold, so the runtime renders a confirm
 * toast on Cmd+Z (lookup table in `_shared.ts` already lists
 * `initList`). Plain `archiveList`, not unarchive — undoing a
 * creation must remove the entity, not just toggle a flag.
 */
export const inverse: Inverse<Args> = ({ listId }) => ({
    name: 'archiveList',
    args: { listId },
});
