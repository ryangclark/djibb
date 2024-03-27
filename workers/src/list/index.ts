import { z } from 'zod';
import { LIST_ID_LENGTH } from './constants';

export const ListSchema = z.object({
	child_element_refs: z.array(z.string()),
	description: z.string().optional(),
	id: z.string().length(LIST_ID_LENGTH),
	time_created: z.string().datetime(),
	time_deleted: z.string().datetime().nullable(),
	time_updated: z.string().datetime(),
	title: z.string(),
	type: z.literal('list'),
	version: z.number(),
});

export const LIST_GROUP_KEY_PREFIX = `group/`;
export const listGroupKey = (id: string) => `${LIST_GROUP_KEY_PREFIX}${id}`;
export const listGroupID = (key: string) => {
	if (!key.startsWith(LIST_GROUP_KEY_PREFIX)) {
		throw new Error(`Invalid list group key: ${key}`);
	}
	return key.substring(LIST_GROUP_KEY_PREFIX.length);
};

/**
 * The top-level List element. The List Itself.
 */
export type List = z.TypeOf<typeof ListSchema>;

export const ListGroupSchema = z.object({
	child_element_refs: z.array(z.string()),
	description: z.string().optional(),
	id: z.string(),
	parent_element_ref: z.string(),
	time_created: z.string().datetime(),
	time_deleted: z.string().datetime().nullable(),
	time_updated: z.string().datetime(),
	title: z.string(),
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
	.superRefine(({ max_value, min_value, target_value, value }, ctx) => {
		if (max_value !== undefined) {
			if (value > max_value) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `\`value\` ${value} cannot be greater than \`max_value\` ${max_value}`,
				});
			}
			if (target_value > max_value) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `\`target_value\` ${target_value} cannot be greater than \`max_value\` ${max_value}`,
				});
			}
			if (min_value !== undefined && min_value >= max_value) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `\`min_value\` ${min_value} cannot be equal or greater than \`max_value\` ${max_value}`,
				});
			}
		}

		if (min_value !== undefined) {
			if (min_value > value) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `\`value\` ${value} cannot be less than \`min_value\` ${min_value}`,
				});
			}
			if (min_value > target_value) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `\`target_value\` ${target_value} cannot be less than \`min_value\` ${min_value}`,
				});
			}
		}
	});

/** Where we want to be, where we can be, and where we are. */
export type Quantity = z.TypeOf<typeof QuantitySchema>;

export const LIST_ITEM_KEY_PREFIX = `item/`;
export const listItemKey = (id: string) => `${LIST_ITEM_KEY_PREFIX}${id}`;
export const listItemID = (key: string) => {
	if (!key.startsWith(LIST_ITEM_KEY_PREFIX)) {
		throw new Error(`Invalid list item key: ${key}`);
	}
	return key.substring(LIST_ITEM_KEY_PREFIX.length);
};

export const ListItemSchema = z.object({
	description: z.string().optional(),
	id: z.string(),
	parent_element_ref: z.string(),
	quantity: QuantitySchema,
	time_created: z.string().datetime(),
	time_deleted: z.string().datetime().nullable(),
	time_updated: z.string().datetime(),
	title: z.string(),
	type: z.literal('item'),
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
