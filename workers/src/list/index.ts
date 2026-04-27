import { z } from 'zod';

import { AuthorizationRulesSchema } from '../auth/rules';
import { ID_LENGTH, IdTypes } from '../id';
import { DatelikeToDateSchema } from '../schema';

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
]);

/** An element in a list/template, or the entity itself. */
export type ListElement = List | Template | ListGroup | ListItem;
