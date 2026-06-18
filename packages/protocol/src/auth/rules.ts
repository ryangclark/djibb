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
    // ADR 0021: write-without-read / append-only — the dual of
    // `viewer` (which reads but can't write). A `submitter` can append
    // to a list (`createListItem` via `APPEND_ROLES`) but is excluded
    // from every structural/destructive mutator (`EDIT_ROLES`). It is a
    // `DefaultRoleEnum` value (anon callers on a contributed-style list
    // resolve to it) but deliberately NOT an `AccountRoleEnum`/
    // `InvitableRoleEnum` value — you don't *grant* submitter, it's the
    // public floor of an append-only list. The matching read-denial
    // (view-floor) lands in issue #13; here `submitter` is write-gated
    // only and reads stay open platform-wide (status quo).
    'submitter',
    'viewer',
    // ADR 0011 §Step 10a.3 / ADR 0008: identity for mutations
    // originated by another DO inside the cluster (cascade-archive,
    // cascade-restore). Deliberately omitted from `AccountRoleEnum`
    // and `DefaultRoleEnum` so a session lookup, an explicit
    // `authorized_accounts` grant, or a default-role fall-through
    // can never produce it — `'system'` is structurally only
    // reachable from a direct DO-stub call that passes
    // `authorizedRole: 'system'`. Cascade mutators gate on
    // `SYSTEM_ROLES` (`workers/src/list/mutators/_shared.ts`); the
    // HTTP boundary additionally rejects this value defensively in
    // `workers/src/list/fetch.ts` even though no current resolver
    // path can produce it.
    'system',
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
 * Roles that may be granted through an invitation (ADR 0009).
 * `AccountRoleEnum` minus `owner`: ownership is *transferred* via the
 * `transferOwnership` mutator, never *invited*. Excluding `owner` here
 * keeps the invite path consistent with `changeMemberRole`, which only
 * lets the current owner mint a new owner — without this narrowing an
 * `admin` (who passes `inviteByIdentity`'s `OWNER_ROLES` gate) could
 * invite a second `owner` and break the single-owner invariant
 * (`assertSingleOwner`).
 */
export const InvitableRoleEnum = AccountRoleEnum.exclude([
    AuthorizationRoleEnum.enum.owner,
]);

/**
 * Roles that may be granted through an invitation.
 */
export type InvitableRole = z.infer<typeof InvitableRoleEnum>;

/**
 * Possible roles for non-authorized user who, for example, visits the
 * List by URL.
 */
export const DefaultRoleEnum = z.enum([
    AuthorizationRoleEnum.enum.checker,
    AuthorizationRoleEnum.enum.editor,
    AuthorizationRoleEnum.enum.ownerless,
    AuthorizationRoleEnum.enum.restricted,
    // ADR 0021: append-only floor — a list whose `default_role` is
    // `submitter` lets any caller append (createListItem) but nothing
    // else. The Contributed List uses this.
    AuthorizationRoleEnum.enum.submitter,
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
