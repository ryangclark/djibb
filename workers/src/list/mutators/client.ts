/** This is a placeholder file for now. Intended use is to hold the
 * Replicache mutators, and then there are equivalent mutators
 * written for the server. Shared mutators seem more like handcuffs than
 * efficiencies right now, more complicated than they're worth.
 *
 * Want to think through a shared type system of some kind... seems very
 * rabbit-hole-y.
 *
 * These mutators could be implemented by the frontend instead. Keep it in mind.
 * */

import { ReadonlyJSONObject, WriteTransaction } from 'replicache';
import {
    BadMutationError,
    NotFoundError,
    ValidationError,
} from '../../errors';
import { DefaultAuthorizationRules } from '../constants';
import { AuthorizationRules, AuthorizationRulesSchema } from '../../auth/rules';
import {
    List,
    ListElementUnion,
    ListItem,
    ListItemSchema,
    ListSchema,
    Quantity,
    QuantitySchema,
} from '..';
import { z } from 'zod';
import { DEFAULT_LIST_TITLE } from '.';
import { DatelikeToDateSchema } from '../../schema';
import { tryCatchAsync } from '../../utils/trycatch';
import { ID_LENGTH, IdTypes, newId } from '../../id';

export const mutators = { createListItem, initList, setItem, setItemQuantity };

// Replicache values must be plain JSON. Schemas hold Date instances after parse;
// round-tripping through JSON normalizes them via Date#toJSON.
function toStoredValue(value: unknown): ReadonlyJSONObject {
    return JSON.parse(JSON.stringify(value));
}

// export const AddListItemArgsSchema = z.object({})

export const createListItemArgsSchema = z.object({
    accountId: z.string().nullable(),
    item: ListItemSchema,
    timestamp_client: DatelikeToDateSchema.nullable(),
});

export type createListItemArgs = z.infer<typeof createListItemArgsSchema>;

export async function createListItem(
    tx: WriteTransaction,
    { accountId, item, timestamp_client }: createListItemArgs
) {
    createListItemArgsSchema.parse({ accountId, item, timestamp_client });

    if (!item.parent_element_ref) {
        console.error('`createListItem()` error: invalid parent element ref');
        throw new BadMutationError('invalid `parent_element_ref`');
    }

    const { data: parentElement, error } = await tryCatchAsync(
        getListElement(tx, item.parent_element_ref)
    );

    if (error) {
        console.error('`createListItem()` error getting parent element');
        throw error; // is this the best way to handle this...?
    }

    if (parentElement.type === 'list' || parentElement.type === 'group') {
        parentElement.child_element_refs.push(item.id);
    } else {
        console.error(
            '`createListItem()` unexpected parentElement.type',
            parentElement.type
        );

        throw new BadMutationError('unexpected `parentElement.type`');
    }

    const promises = [
        tx.set(parentElement.id, toStoredValue(parentElement)),
        setItem(tx, item),
        logMutation(tx, {
            args: { accountId, item },
            id: '',
            name: 'createListItem',
            timestamp_client: item.time_created,
        }),
        incrementListVersion(tx),
    ];

    await Promise.all(promises);
}

async function getListElement(tx: WriteTransaction, id: string) {
    const rawElement = await tx.get(id);

    if (!rawElement) {
        console.error('`createListItem()` error: parent element not found', id);
        throw new BadMutationError('parent element not found');
    }

    const parseResult = ListElementUnion.safeParse(rawElement);

    if (parseResult.error) {
        console.error(
            '`createListItem()` parse error of raw element:',
            z.prettifyError(parseResult.error)
        );
        console.log('prettifyError:', z.prettifyError(parseResult.error))
        console.log('parseResult.error', parseResult.error)
        throw new BadMutationError('invalid element');
    }

    return parseResult.data;
}

async function incrementListVersion(tx: WriteTransaction) {
    const scanResult = tx.scan({ prefix: `${IdTypes['list']}/`, limit: 1 });

    let listElement;
    for await (const result of scanResult) {
        // TODO: see if we can scope this check to only dev env
        const parseResult = ListSchema.safeParse(result);

        if (parseResult.success) {
            listElement = parseResult.data;
            break;
        }
    }

    if (!listElement) throw new BadMutationError('list element not found');

    listElement.version += 1;

    return tx.set(listElement.id, toStoredValue(listElement));
}

export const initListArgsSchema = z.object({
    accountId: z.string().nullable(),
    listId: ListSchema.shape.id,
    timestamp_client: DatelikeToDateSchema,
    workspaceId: ListSchema.shape.workspace_id,
});

export type initListArgs = z.infer<typeof initListArgsSchema>;

export async function initList(
    tx: WriteTransaction,
    { accountId, listId, timestamp_client, workspaceId }: initListArgs
) {
    if (!(await tx.isEmpty())) {
        // TODO: remove log
        console.log('`initList()` returning! db is NOT empty');
        // trying throw here instead so we dont' actually save the mutation on client and then bombard the server
        // throw new BadMutationError('db is not empty!');
        return;
    }

    console.log('`initList()` running!', listId);

    const promises = [];

    let authorizationRules: AuthorizationRules = DefaultAuthorizationRules;

    if (accountId) {
        authorizationRules = {
            authorized_accounts: { [accountId]: { role: 'owner' } },
            default_role: 'restricted',
            set_by: 'user',
        };

        const parseResult =
            AuthorizationRulesSchema.safeParse(authorizationRules);

        if (!parseResult.success) {
            console.log(
                'initList authorizationRules parse error:',
                z.prettifyError(parseResult.error)
            );

            return;
            // throw new ValidationError();
        }

        promises.push(
            tx.set('m/auth_default_role', 'restricted'),
            tx.set('m/auth_rules_set_by', accountId)
            // tx.set('auth/accounts', [account])
        );
    }

    promises.push(
        tx.set('m/auth_default_role', authorizationRules.default_role)
    );

    // Set the list itself
    const list: List = {
        authorization_rules: authorizationRules,
        child_element_refs: [],
        forked_from_id: null,
        type: 'list',
        id: listId,
        name: DEFAULT_LIST_TITLE,
        time_created: timestamp_client,
        time_deleted: null,
        time_updated: timestamp_client,
        version: 1,
        workspace_id: workspaceId,
    };

    const parseResult = ListSchema.safeParse(list);

    if (!parseResult.success) {
        console.error(
            '`initList()` list validation error:',
            z.prettifyError(parseResult.error)
        );

        // i dont know if we should be throwing?
        throw new ValidationError();
    }

    promises.push(tx.set(list.id, toStoredValue(list)));

    // TODO: this needs to set a mutation!!! We don't log those client side?
    // logMutation(tx, mutation);

    await Promise.all(promises);
}

// Would love to be able to have an `args.diff` property to show the change made
const mutationSchema = z.object({
    args: z.any(), // can this type be narrowed?
    id: z.string().length(ID_LENGTH + IdTypes['mutation'].length + 1),
    name: z.string(),
    timestamp_client: DatelikeToDateSchema,
});

type mutation = z.infer<typeof mutationSchema>;

async function logMutation(tx: WriteTransaction, mutation: mutation) {
    if (!mutation) throw new BadMutationError('invalid mutation');

    const parseResult = mutationSchema.safeParse({
        ...mutation,
        id: newId('mutation'),
    });

    if (parseResult.error) {
        console.error(
            '`logMutation()` parse error:',
            z.prettifyError(parseResult.error)
        );
        throw parseResult.error;
    }

    await tx.set(parseResult.data.id, toStoredValue(parseResult.data));
}

export async function setItemQuantity(
    tx: WriteTransaction,
    {
        accountId,
        itemId,
        quantity,
        timestamp_client,
    }: {
        accountId: string | null;
        itemId: string;
        quantity: Quantity;
        timestamp_client: Date;
    }
) {
    const parseResult = QuantitySchema.safeParse(quantity);
    if (!parseResult.success) {
        console.error(
            '`setItemQuantity()` quantity parse error:',
            z.prettifyError(parseResult.error)
        );
        throw new ValidationError();
    }

    const raw = await tx.get(itemId);
    if (!raw) {
        console.error(`\`setItemQuantity()\` item "${itemId}" not found`);
        throw new NotFoundError(`item "${itemId}" not found`);
    }

    const item = raw as any;

    await tx.set(
        itemId,
        toStoredValue({
            ...item,
            value: parseResult.data,
            time_updated: timestamp_client.toISOString(),
            version: (item.version ?? 0) + 1,
        })
    );
}

export async function setItem(tx: WriteTransaction, item: ListItem) {
    const parseResult = ListItemSchema.safeParse(item);

    if (!parseResult.success) {
        console.log('`setItem()` validation error:');
        throw new ValidationError();
    }
    return tx.set(item.id, toStoredValue(item));
}

// TODO: not-yet-implemented mutators carried over from the pre-split
// `mutators.ts`. Not registered in `ClientMutators`; wire them up once
// the relevant features (workspaces, auth rules, list groups) land.
export async function setWorkspace(_tx: WriteTransaction, _workspaceId: string) {
    throw new Error('setWorkspace: not yet implemented');
}

export async function setAuthorizationRules(
    _tx: WriteTransaction,
    _rules: AuthorizationRules
) {
    throw new Error('setAuthorizationRules: not yet implemented');
}

export async function setGroup(_tx: WriteTransaction, _group: unknown) {
    throw new Error('setGroup: not yet implemented');
}
