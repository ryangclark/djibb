import { z } from 'zod';

import { AuthorizationRulesSchema } from '../auth/rules';
import { ID_LENGTH, IdTypes } from '../id';
import { DatelikeToDateSchema } from '../schema';

export const ListSchema = z.object({
    authorization_rules: AuthorizationRulesSchema,
    child_element_refs: z.array(z.string()),
    description: z.string().optional(),
    id: z.string().length(ID_LENGTH + IdTypes['list'].length + 1), // +1 for the slash
    name: z.string(),
    time_created: DatelikeToDateSchema,
    time_deleted: DatelikeToDateSchema.nullable(),
    time_updated: DatelikeToDateSchema,
    type: z.literal('list'),
    workspace_id: z
        .string()
        .length(ID_LENGTH + IdTypes['workspace'].length + 1) // +1 for slash
        .nullable(),
    version: z.number(),
});

/**
 * The top-level List element. The List Itself.
 */
export type List = z.TypeOf<typeof ListSchema>;

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
]);

/** An element in a list, or even the list itself. */
export type ListElement = List | ListGroup | ListItem;
