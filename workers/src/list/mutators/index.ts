import { z } from 'zod';

import { DatelikeToDateSchema, ReadonlyJSONValueSchema } from '../../schema';
import { ListItem, Quantity } from '..';
import { SimpleWriteTransaction } from '../../replicache';
import { AuthorizationRole, AuthorizationRules } from '../../auth/rules';
import { MutatorDefs, MutatorReturn } from 'replicache';

import { initList as clientInitList } from './client';
import {
    createListItem as serverCreateListItem,
    initList as serverInitList,
    setItemQuantity as serverSetItemQuantity,
} from './server';
import { setItem, setItemQuantity } from './shared';
import { Account } from '../../account';
import { ID_LENGTH, IdTypes } from '../../id';

export {
    MutationArgsSchema,
    MutationSchema,
    type MutationArgs,
    type Mutation,
} from './schema';

/** Default authorization rules when list created anonymously.  */
export const DEFAULT_LIST_AUTHORIZATION_RULES: AuthorizationRules = {
    authorized_accounts: {},
    default_role: 'ownerless',
    set_by: 'defaults',
};
export const DEFAULT_LIST_TITLE = '';

/**
 * TODO:
 * [] mutators should fire a `logMutation()` call
 * [] implement `logMutation()` - keep it simple stupid
 * [] auth checks for each mutator
 * [] implement `SetAuthRules()` mutation
 */

// export type ListMutators = typeof mutators;
// export const mutators = { initList, setItemQuantity };

// I'd like to have this interface be a list of the shared
// mutators, and then have ServerMutators below "implement"
// this interface.
export interface Mutators {
    setItem: Function;
    setItemQuantity: (
        tx: SimpleWriteTransaction,
        {
            authorizedRole,
            itemId,
            quantity,
        }: {
            authorizedRole: AuthorizationRole;
            itemId: string;
            quantity: Quantity;
        }
    ) => Promise<void>;
}

export const ClientMutators: MutatorDefs = {
    initList: clientInitList,
    setItem: setItem,
    setItemQuantity: setItemQuantity,
};

// Not sharing mutators any longer.
// export const SharedMutators: MutatorDefs = {};

export const ServerMutators: {
    [key: string]: (
        sql: SqlStorage,
        // authorizedAccounts: Readonly<Account[]>,
        authorizedRole: AuthorizationRole,
        args: any,
        nextVersion: number
    ) => MutatorReturn;
} = {
    createListItem: serverCreateListItem,
    initList: serverInitList,
    setItemQuantity: serverSetItemQuantity,
};
