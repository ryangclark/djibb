import { z } from 'zod';

// How the rules were set.
export const RulesSetByEnum = z.enum(['defaults', 'user', 'workspace']);
export type AuthorizationRulesSetBy = z.infer<typeof RulesSetByEnum>;

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
    AuthorizationRoleEnum.enum.admin,
    AuthorizationRoleEnum.enum.checker,
    AuthorizationRoleEnum.enum.editor,
    AuthorizationRoleEnum.enum.owner,
    AuthorizationRoleEnum.enum.viewer,
]);

/**
 * Roles that can be assigned to an Account.
 */
export type AccountRole = z.infer<typeof AccountRoleEnum>;

/**
 * Possible roles for non-authorized user who, for example, visits the
 * List by URL.
 */
export const DefaultRoleEnum = z.enum([
    AuthorizationRoleEnum.enum.checker,
    AuthorizationRoleEnum.enum.editor,
    AuthorizationRoleEnum.enum.ownerless,
    AuthorizationRoleEnum.enum.restricted,
    AuthorizationRoleEnum.enum.viewer,
]);

/**
 * Possible roles for non-authorized user who, for example, visits the
 * List by URL.
 */
export type DefaultRole = z.infer<typeof DefaultRoleEnum>;

export const AuthorizedAccountSchema = z.object({
    role: AccountRoleEnum,
});

// @UPGRADE:
// This needs to also have a way for all members of a workspace to have access,
// even if their account id isn't in `authorized_accounts`.
//      "An entire organization could be invited to collaborate as part of
//       another organization. For example, pull in an agency to
//       collaborate on a project."
export const AuthorizationRulesSchema = z.object({
    authorized_accounts: z.record(z.string(), AuthorizedAccountSchema),
    default_role: DefaultRoleEnum,
    set_by: RulesSetByEnum,
});

export type AuthorizationRules = z.TypeOf<typeof AuthorizationRulesSchema>;
