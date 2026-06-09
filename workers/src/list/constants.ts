import type { AuthorizationRules } from '../auth/rules';

export const DefaultAuthorizationRules: AuthorizationRules = {
    authorized_accounts: {},
    default_role: 'ownerless',
    set_by: 'defaults',
};

export const LIST_ELEMENT_TYPES = {
    GROUP: 'group',
    ITEM: 'item',
    LIST: 'list',
};
