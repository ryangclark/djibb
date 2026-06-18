import { z } from 'zod';

import { AuthorizationRulesSchema } from '../auth/rules';
import { ID_LENGTH, IdTypes } from '../id';
import { DatelikeToDateSchema } from '../schema';

/**
 * Well-known "slot" assignments for entities that fill a singular role
 * for an account, workspace, or the system as a whole. See ADR 0011.
 *
 * Nullable everywhere by default; only specific entities (the personal
 * Workspace for an account, the account's Inbox List, the global Seed
 * Pool List) carry a non-null value. Booleans like `is_personal` /
 * `system: true` collapse onto this single enum column so further roles
 * can be added without further schema churn.
 *
 *  - `personal_workspace` — Workspace entity, exactly one per account.
 *  - `inbox`              — List entity, exactly one per account.
 *  - `seed_pool`          — List entity, exactly one globally.
 *  - `contributed`        — List entity, exactly one globally; the
 *                           append-only holding pen `djibb contribute`
 *                           writes into (ADR 0021, `default_role:
 *                           'submitter'`).
 */
export const SlotEnum = z.enum([
    'personal_workspace',
    'inbox',
    'seed_pool',
    'contributed',
]);

export type Slot = z.TypeOf<typeof SlotEnum>;

/**
 * The one global Seed Pool List — a well-known deterministic singleton
 * (ADR 0011, `slot: 'seed_pool'`). Its id is derived once, offline, from
 * the stable seed `'djibb:seed_pool'` via the same sha256→url-safe scheme
 * `djibb promote` uses (see `workers/bin/djibb.ts` `detId`), so the value
 * is identical in every environment and can be hardcoded here as the
 * single source of truth shared by the CLI (which bootstraps the pool)
 * and the homepage (which reads it). Kept as a literal rather than
 * recomputed at runtime so the Worker bundle stays free of node:crypto;
 * the CLI asserts its own derivation matches this constant.
 */
export const SEED_POOL_LIST_ID = 'l/LWmRT14-cOUtJ9-nsSwQe';

/**
 * The one global **Contributed** List — the append-only holding pen
 * `djibb contribute` writes into (issue #9, ADR 0021). Operator-owned,
 * `slot: 'contributed'`, `default_role: 'submitter'`: any anonymous
 * caller can append a reference to a freshly-minted Blank
 * (`createListItem` via `APPEND_ROLES`) but cannot mutate existing
 * entries (every other mutator gates on `EDIT_ROLES`). `djibb promote`
 * reads it to source Seed Pool candidates.
 *
 * Derived once, offline, from the stable seed `'djibb:contributed'` via
 * the same sha256→url-safe scheme as {@link SEED_POOL_LIST_ID} (see
 * `packages/server-cf/bin/djibb.ts` `detId`); identical in every
 * environment, hardcoded here as the single source of truth shared by
 * the CLI and the site. Kept a literal (not recomputed) so the Worker
 * bundle stays free of node:crypto; the CLI asserts its own derivation
 * matches this constant.
 */
export const CONTRIBUTED_LIST_ID = 'l/RG5n-jjnV9BmqO4WSr4Eu';

/**
 * The one platform **operator** account — a fixed, well-known singleton,
 * the account-identity sibling of {@link SEED_POOL_LIST_ID}. It owns the
 * platform's shared entities (the Seed Pool List, the Blank Templates)
 * and is the *only* principal permitted to set privileged `initList`
 * fields (`slot`, `defaultRole`). `djibb promote` authenticates as it.
 *
 * Unlike entity ids, account ids are unconstrained (`AccountSchema.id`
 * is a bare `z.string()`) and are never Durable-Object-routed, so this
 * can be a short, human-readable literal rather than a 21-char suffix.
 * The short form is also collision-proof: `newId('account')` only ever
 * mints 21-char suffixes, so a real user can never be issued `a/djibb`.
 *
 * Kept as a constant (not an env var) deliberately: the operator's
 * *identity* is permanent and identical across environments — only its
 * session token (the bearer secret carried by `promote`) is secret and
 * rotatable. Seed this exact id via `packages/server-cf/bin/seed-operator.ts`.
 */
export const OPERATOR_ACCOUNT_ID = 'a/djibb';

/**
 * Fields shared by every top-level entity (List, Template). The `type`
 * literal and `id` length differ per concrete entity and are added by
 * the extending schemas.
 */
const entityBaseFields = {
    authorization_rules: AuthorizationRulesSchema,
    /**
     * Breadcrumb pointing back at the Workspace whose cascade-archive
     * sweep brought this entity down (ADR 0008, ADR 0011 §Step 10a).
     * NULL on every live entity, NULL on entities the user manually
     * archived, set only by `cascadeArchiveList` to the workspace ID.
     *
     * Cleared on `unarchiveEntity`. `restoreWorkspace` (10a.5) scans
     * `WHERE cascade_source = ? AND time_deleted IS NOT NULL` to find
     * exactly the children this specific deletion brought down —
     * manually-archived siblings stay archived because their
     * `cascade_source` is null.
     */
    cascade_source: z.string().nullable().optional(),
    child_element_refs: z.array(z.string()),
    description: z.string().optional(),
    /**
     * Lineage pointer. The ID's type prefix (`t/...` vs `l/...`) tells
     * you whether the source was a Template or another List, so no
     * separate field is needed.
     */
    forked_from_id: z.string().nullable(),
    /**
     * Open JSON bag for presentation-y, speculative, and client-specific
     * fields that don't warrant first-class columns. Today: workspaces
     * use `meta.image_url` via `setWorkspaceImage`. Tomorrow: icon
     * emoji, theme color, UI prefs, A/B-test flags, etc.
     *
     * Promotion rule: a field earns its own column when the catalog
     * needs to filter/sort/index on it, or when auth/security cares.
     * `slot` clears that bar; `image_url` does not. ADR 0011 §Step 5
     * established the convention.
     *
     * `null` means "never written or fully cleared." Empty `{}` is not
     * a meaningful state — writers that remove the last key should
     * clear to `null`.
     */
    meta: z.record(z.string(), z.unknown()).nullable(),
    name: z.string(),
    /**
     * URL-routing alias for this entity, per-type-namespaced via the D1
     * `UNIQUE(type, slug)` index (ADR 0011 §Step 7b.5). The D1 column
     * is NOT NULL; the projection writer auto-defaults to the id suffix
     * (the nanoid after the type prefix) when an entity emits without
     * a DO-resident slug. Workspaces opt in via the `slug` field on
     * their entity row and `setWorkspaceSlug` (with an in-DO preflight
     * holding the cross-DO UNIQUE check before the mutator commits);
     * lists / templates currently leave it unset, accepting the
     * id-suffix default.
     *
     * Optional in the DO schema so existing entity-creation paths
     * (initList, mintTemplate, …) keep working without per-entity slug
     * arguments. Length cap mirrors the legacy `SLUG_PATTERN` (40
     * chars).
     */
    slug: z.string().min(1).max(40).optional(),
    /**
     * Well-known slot this entity fills, if any. See `SlotEnum` and
     * ADR 0011. `null` for ordinary user-created entities.
     */
    slot: SlotEnum.nullable(),
    time_created: DatelikeToDateSchema,
    time_deleted: DatelikeToDateSchema.nullable(),
    time_updated: DatelikeToDateSchema,
    workspace_id: z
        .string()
        .length(ID_LENGTH + IdTypes['workspace'].length + 1) // +1 for slash
        .nullable(),
    version: z.number(),
};

export const ListSchema = z.object({
    ...entityBaseFields,
    id: z.string().length(ID_LENGTH + IdTypes['list'].length + 1), // +1 for slash
    type: z.literal('list'),
});

/**
 * The top-level List element. The List Itself.
 */
export type List = z.TypeOf<typeof ListSchema>;

export const TemplateSchema = z.object({
    ...entityBaseFields,
    id: z.string().length(ID_LENGTH + IdTypes['template'].length + 1), // +1 for slash
    type: z.literal('template'),
});

/**
 * A reusable, remixable List shape. Same DO machinery as a List;
 * distinguished only by the `type` discriminator and ID prefix. See
 * CONTEXT.md.
 */
export type Template = z.TypeOf<typeof TemplateSchema>;

export const WorkspaceEntitySchema = z.object({
    ...entityBaseFields,
    id: z.string().length(ID_LENGTH + IdTypes['workspace'].length + 1), // +1 for slash
    type: z.literal('workspace'),
});

/**
 * A Workspace as a DjibbList-substrate entity (ADR 0011). Identical
 * machinery to List/Template — only the `type` discriminator and ID
 * prefix differ. The legacy `workspaces` D1 table that previously
 * carried this row was dropped in §7b.6; the entity row in
 * `workspace_entities` is now the sole D1 projection.
 */
export type WorkspaceEntity = z.TypeOf<typeof WorkspaceEntitySchema>;

/**
 * Set of `type` discriminator values that represent a "top-level entity
 * row" (the row that owns its DO, the row a pull cookie's version
 * tracks, the row that emits to the D1 catalog). Single source of truth
 * for the predicates and SQL filters scattered across the list package.
 */
export const ENTITY_ROW_TYPES = ['list', 'template', 'workspace'] as const;
export type EntityRowType = (typeof ENTITY_ROW_TYPES)[number];

export function isEntityRowType(t: unknown): t is EntityRowType {
    return (
        t === 'list' || t === 'template' || t === 'workspace'
    );
}

/**
 * Type predicate for narrowing a parsed `ListElement` (the discriminated
 * union) down to "this is an entity row" — i.e. one of `List | Template |
 * WorkspaceEntity`. Use this when the surrounding code needs access to
 * entity-only fields (`authorization_rules`, `workspace_id`, `slot`,
 * etc.) that don't exist on the item/group branches of the union.
 */
export function isEntityRow(
    element: ListElement
): element is List | Template | WorkspaceEntity {
    return isEntityRowType(element.type);
}

/**
 * SQL fragment for `WHERE type IN (...)` clauses that target every
 * entity-row type. Kept as a single string so adding/removing types
 * doesn't require chasing every callsite — though new types should
 * also extend `ENTITY_ROW_TYPES` and any TS-side type guards.
 */
export const ENTITY_ROW_TYPES_SQL_LIST = `'list', 'template', 'workspace'`;

export const ListGroupSchema = z.object({
    child_element_refs: z.array(z.string()),
    description: z.string().optional(),
    id: z.string().length(ID_LENGTH + IdTypes['group'].length + 1),
    name: z.string(),
    parent_element_ref: z.string(),
    time_created: DatelikeToDateSchema,
    time_deleted: DatelikeToDateSchema.nullable(),
    time_updated: DatelikeToDateSchema,
    type: z.literal('group'),
    version: z.number(),
});

/** A group of list elements within a list. */
export type ListGroup = z.TypeOf<typeof ListGroupSchema>;

export const QuantitySchema = z
    .object({
        max_value: z.number().optional(),
        min_value: z.number().optional(),
        target_value: z.number(),
        unit: z.string(),
        value: z.number(),
    })
    // Use `superRefine` to add additional logic to ensure the various
    // properties don't conflict (e.g. `target_value` > `max_value`).
    .superRefine((val, ctx) => {
        const { max_value, min_value, target_value, value } = val;

        if (max_value !== undefined) {
            if (value > max_value) {
                ctx.addIssue({
                    code: 'custom',
                    message: `\`value\` ${value} cannot be greater than \`max_value\` ${max_value}`,
                });
            }
            if (target_value > max_value) {
                ctx.addIssue({
                    code: 'custom',
                    message: `\`target_value\` ${target_value} cannot be greater than \`max_value\` ${max_value}`,
                });
            }
            if (min_value !== undefined && min_value >= max_value) {
                ctx.addIssue({
                    code: 'custom',
                    message: `\`min_value\` ${min_value} cannot be equal or greater than \`max_value\` ${max_value}`,
                });
            }
        }

        if (min_value !== undefined) {
            if (min_value > value) {
                ctx.addIssue({
                    code: 'custom',
                    message: `\`value\` ${value} cannot be less than \`min_value\` ${min_value}`,
                });
            }
            if (min_value > target_value) {
                ctx.addIssue({
                    code: 'custom',
                    message: `\`target_value\` ${target_value} cannot be less than \`min_value\` ${min_value}`,
                });
            }
        }
    });

/** Where we want to be, where we can be, and where we are. */
export type Quantity = z.TypeOf<typeof QuantitySchema>;

export const ListItemSchema = z.object({
    description: z.string().optional(),
    id: z.string().length(ID_LENGTH + IdTypes['item'].length + 1),
    name: z.string(),
    parent_element_ref: z.string(),
    /**
     * Soft pointer to another entity (any type — the prefix tells you).
     * Checking the local item does NOT propagate state to the referenced
     * entity; this is purely lineage / navigation. See CONTEXT.md.
     */
    references_entity_id: z.string().nullable(),
    time_created: DatelikeToDateSchema,
    time_deleted: DatelikeToDateSchema.nullable(),
    time_updated: DatelikeToDateSchema,
    type: z.literal('item'),
    value: QuantitySchema,
    version: z.number(),
});

/** An item in the list that needs doing or getting. */
export type ListItem = z.TypeOf<typeof ListItemSchema>;

export const ListElementUnion = z.discriminatedUnion('type', [
    ListGroupSchema,
    ListItemSchema,
    ListSchema,
    TemplateSchema,
    WorkspaceEntitySchema,
]);

/** An element in a list/template/workspace, or the entity itself. */
export type ListElement =
    | List
    | Template
    | WorkspaceEntity
    | ListGroup
    | ListItem;
