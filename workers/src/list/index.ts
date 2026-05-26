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
 */
export const SlotEnum = z.enum([
    'personal_workspace',
    'inbox',
    'seed_pool',
]);

export type Slot = z.TypeOf<typeof SlotEnum>;

/**
 * Fields shared by every top-level entity (List, Template). The `type`
 * literal and `id` length differ per concrete entity and are added by
 * the extending schemas.
 */
const entityBaseFields = {
    authorization_rules: AuthorizationRulesSchema,
    child_element_refs: z.array(z.string()),
    description: z.string().optional(),
    /**
     * Lineage pointer. The ID's type prefix (`t/...` vs `l/...`) tells
     * you whether the source was a Template or another List, so no
     * separate field is needed.
     */
    forked_from_id: z.string().nullable(),
    name: z.string(),
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
 * prefix differ. The legacy `workers/src/workspace/index.ts`
 * `WorkspaceSchema` (D1 `workspaces` table row) is what this replaces
 * once the membership/auth migration in steps 7–8 lands.
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
