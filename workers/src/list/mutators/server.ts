import { z } from 'zod';

import { List, ListItemSchema, QuantitySchema } from '..';
import { Account } from '../../account';
import { AuthorizationRole, AuthorizationRoleEnum } from '../../auth/rules';
import { UnauthorizedError, ValidationError } from '../../errors';
import { ID_LENGTH, IdTypes } from '../../id';
import { DefaultAuthorizationRules } from '../constants';
import {
    appendChildElementRef,
    createElement,
    InitializeTables,
    insertListItem,
    setAuthorizationDefaultRole,
    setAuthorizedAccount,
    setItemValueAndVersion,
} from '../sql';
import { MutationArgsSchema } from './schema';

export const mutators = { createListItem, initList, setItemQuantity };

export function initList(
    sql: SqlStorage,
    authorizedRole: AuthorizationRole,
    {
        accountId,
        listId,
        timestamp_client,
        workspaceId,
    }: {
        accountId: string | null;
        listId: string;
        timestamp_client: Date | null;
        workspaceId: string | null;
    }
) {
    if (authorizedRole !== 'ownerless') {
        throw new UnauthorizedError(
            '`initList()` error: authorized role is not "ownerless"'
        );
    }

    console.log('initList listId:', listId);

    const list: List = {
        id: listId,
        authorization_rules: DefaultAuthorizationRules,
        child_element_refs: [],
        // description: '',
        name: '',
        time_created: new Date(),
        time_deleted: null,
        time_updated: new Date(),
        type: 'list',
        workspace_id: null,
        version: 0,
    };

    createElement(sql, list);
    console.log('success!');

    // InitializeTables(sql, {
    //     listId,
    //     clientCreatedTimestamp,
    //     workspaceId,
    // });

    // Need a new SQL mutation or two here.
    // Something like `CreateList(sql, listId, clientCreatedTimestamp?)` to create the list
    // Then mutations like
    // SetAuthRules
    // SetAuthorizedAccount
    // SetWorkspace

    if (accountId) {
        // Private by default. Could upgrade to refer to workspace defaults...
        setAuthorizationDefaultRole(
            sql,
            AuthorizationRoleEnum.enum.restricted,
            'user'
        );
        list.authorization_rules.default_role =
            AuthorizationRoleEnum.enum.restricted;

        setAuthorizedAccount(sql, accountId, null, 'owner');
        list.authorization_rules.authorized_accounts = {
            [accountId]: { role: 'owner' },
        };
    }

    // return list;
}

export const createListItemArgsSchema = MutationArgsSchema.extend({
    item: ListItemSchema,
});

export function createListItem(
    sql: SqlStorage,
    authorizedRole: AuthorizationRole,
    args: unknown,
    nextVersion: number
) {
    if (authorizedRole === 'restricted' || authorizedRole === 'viewer') {
        throw new UnauthorizedError(
            '`createListItem()` error: role is not authorized'
        );
    }

    const parseResult = createListItemArgsSchema.safeParse(args);

    if (!parseResult.success) {
        console.log(
            '`createListItem()` args parse error:',
            parseResult.error.format()
        );
        throw new ValidationError();
    }

    const { item } = parseResult.data;

    insertListItem(sql, { ...item, version: nextVersion });
    appendChildElementRef(sql, item.parent_element_ref, item.id);
}

export const setItemQuantityArgsSchema = MutationArgsSchema.extend({
    itemId: z.string().length(ID_LENGTH + IdTypes['item'].length + 1),
    quantity: QuantitySchema,
});

export function setItemQuantity(
    sql: SqlStorage,
    authorizedRole: AuthorizationRole,
    args: unknown,
    nextVersion: number
) {
    if (authorizedRole === 'restricted' || authorizedRole === 'viewer') {
        throw new UnauthorizedError(
            '`setItemQuantity()` error: role is not authorized'
        );
    }

    const parseResult = setItemQuantityArgsSchema.safeParse(args);

    if (!parseResult.success) {
        console.log(
            '`setItemQuantity()` args parse error:',
            parseResult.error.format()
        );
        throw new ValidationError();
    }

    const { itemId, quantity } = parseResult.data;

    setItemValueAndVersion(sql, {
        itemId,
        value: quantity,
        version: nextVersion,
    });
}
