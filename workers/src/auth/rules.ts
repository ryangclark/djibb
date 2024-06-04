import { z } from 'zod';

// How the rules were set.
export const RulesSetByEnum = z.enum(['defaults', 'user', 'workspace']);

export const AuthorizationRoleEnum = z.enum([
    'admin',
    'checker',
    'editor',
    'owner',
    'ownerless',
    'restricted',
    'viewer',
]);

export type AuthorizationRole = z.infer<typeof AuthorizationRoleEnum>;

/**
 * Roles that can be assigned to an Account.
 */
export const AccountRoleEnum = AuthorizationRoleEnum.extract([
    AuthorizationRoleEnum.Enum.admin,
    AuthorizationRoleEnum.Enum.checker,
    AuthorizationRoleEnum.Enum.editor,
    AuthorizationRoleEnum.Enum.owner,
    AuthorizationRoleEnum.Enum.viewer,
]);

/**
 * Roles that can be assigned to an Account.
 */
export type AccountRole = z.infer<typeof AccountRoleEnum>;

/**
 * Possible roles for non-authorized user who, for example, visits the
 * List by URL.
 */
export const GeneralRoleEnum = z.enum([
    AuthorizationRoleEnum.Enum.checker,
    AuthorizationRoleEnum.Enum.editor,
    AuthorizationRoleEnum.Enum.ownerless,
    AuthorizationRoleEnum.Enum.restricted,
    AuthorizationRoleEnum.Enum.viewer,
]);

/**
 * Possible roles for non-authorized user who, for example, visits the
 * List by URL.
 */
export type GeneralRole = z.infer<typeof GeneralRoleEnum>;

const AuthorizedAccountSchema = z.object({
    role: AccountRoleEnum,
});

// @UPGRADE:
// This needs to also have a way for all members of a workspace to have access,
// even if their account id isn't in `authorized_accounts`.
//      "An entire organization could be invited to collaborate as part of
//       another organization. For example, pull in an agency to
//       collaborate on a project."
const AuthorizationRulesSchema = z.object({
    authorized_accounts: z.record(z.string(), AuthorizedAccountSchema),
    general_role: GeneralRoleEnum,
    set_by: RulesSetByEnum,
});

export type AuthorizationRules = z.TypeOf<typeof AuthorizationRulesSchema>;
