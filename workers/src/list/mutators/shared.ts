import { ListItem, ListItemSchema, Quantity, QuantitySchema } from '..';
import { AuthorizationRole } from '../../auth/rules';
import {
    FailedPreconditionError,
    NotFoundError,
    ParseError,
    UnauthorizedError,
} from '../../errors';
import { SimpleWriteTransaction } from '../../replicache';

/**
 * Ongoing list of concerns with this function:
 * - it only handles List Elements, is that ok? (could simply rename it)
 * - what other functions/cases might we need?
 */
export async function setItem(tx: SimpleWriteTransaction, item: ListItem) {
    const parseResult = ListItemSchema.safeParse(item);

    if (!parseResult.success) {
        console.error('`setItem()` parse error:', parseResult.error.format());
        throw new ParseError();
    }

    return tx.set(item.id, {
        ...item,
        time_created: item.time_created.toISOString(),
        time_deleted: item.time_deleted
            ? item.time_deleted.toISOString()
            : null,
        time_updated: item.time_updated.toISOString(),
    });
}

export async function setItemQuantity(
    tx: SimpleWriteTransaction,
    {
        authorizedRole,
        itemId,
        quantity,
    }: { authorizedRole: AuthorizationRole; itemId: string; quantity: Quantity }
) {
    if (authorizedRole === 'restricted' || authorizedRole === 'viewer') {
        throw new UnauthorizedError();
    }

    const item: any = tx.get(itemId);

    if (!item) {
        console.error(`\`setItemQuantity()\` item "${itemId}" not found!`);
        throw new NotFoundError(`item "${itemId}" not found!`);
    }

    if (item.time_deleted) {
        console.info(`\`setItemQuantity()\` "${itemId}" is deleted!`);
        throw new FailedPreconditionError(`"${itemId}" is deleted`);
    }

    const parseResult = QuantitySchema.safeParse(quantity);

    if (!parseResult.success) {
        console.log(
            '`setItemQuantity()` quantity parse error:',
            parseResult.error.format()
        );
        throw new ParseError();
    }

    return setItem(tx, {
        ...item,
        quantity: parseResult.data,
    });
}
