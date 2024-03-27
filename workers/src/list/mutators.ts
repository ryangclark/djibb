/**
 * This file contains mutators for Replicache, which runs each
 * mutation on the client in order to optimistically update the
 * client while sending the same input data to the server, so it can
 * run the same mutation and respond with the authoritative state
 * (server and client don't have to produce the same end result!).
 */

import {
	ListGroup,
	ListGroupSchema,
	ListItem,
	ListItemSchema,
	Quantity,
	listGroupKey,
	listItemKey,
} from './index';
import { SimpleWriteTransaction } from '../replicache';

export type ListMutators = typeof mutators;
export const mutators = { setItemQuantity };

/**
 * Create or update a List Item.
 * @throws zod parsing error, if any
 */
export async function setItem(tx: SimpleWriteTransaction, item: ListItem) {
	return tx.set(listItemKey(item.id), ListItemSchema.parse(item));
}

export async function setItemQuantity(
	tx: SimpleWriteTransaction,
	{ itemId, quantity }: { itemId: string; quantity: Quantity }
) {
	const itemKey = listItemKey(itemId);
	const item = (await tx.get(itemKey)) as ListItem;

	if (!item) {
		console.info(`\`setItemQuantity()\` item "${itemKey}" not found!`, item);
		return;
	}
	if (item.time_deleted) {
		console.info(`\`setItemQuantity()\` item "${itemKey}" is deleted!`);
		return;
	}

	console.log('`setItemQuantity()` running! item:', item);

	return setItem(tx, {
		...item,
		quantity,
		time_updated: new Date().toISOString(),
	});
}

/**
 * Create or update a List Group.
 * @throws zod parsing error, if any
 */
export async function setGroup(tx: SimpleWriteTransaction, group: ListGroup) {
	await tx.set(listGroupKey(group.id), ListGroupSchema.parse(group));
}
