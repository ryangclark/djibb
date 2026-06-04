import type { AuthorizationRole, AuthorizationRules } from './rules';

export type Session = { account_id: string } | null;

/**
 * Resolves the AuthorizationRole an account holds against a single entity.
 *
 * Specificity (highest to lowest):
 *   1. authorized_accounts[account_id] — explicit per-entity grant or demotion
 *   2. workspace membership — passed through as-is (ADR 0011 §Step 4
 *      retired the legacy 4-tier `WorkspaceRoleEnum`; memberships now
 *      carry `AuthorizationRole` directly, so what used to be a
 *      translation table is now an identity pass-through)
 *   3. default_role — the floor for anyone else (including anonymous)
 *
 * An explicit `authorized_accounts` entry wins both directions: it can grant
 * access above workspace membership *and* demote a workspace admin to
 * `restricted` on a sensitive entity.
 *
 * Pure: no I/O. Callers fetch rules and workspace_role and pass them in.
 * The canonical workspace_role lookup is `GetMembership` in
 * `workers/src/workspace/service.ts`, which reads `entity_memberships`
 * (the projection that landed in ADR 0011 §Step 7b.2 in place of the
 * ADR's originally-named `account_authorizations`).
 */
export function resolveRole(
    session: Session,
    rules: AuthorizationRules,
    workspace_role: AuthorizationRole | null,
): AuthorizationRole {
    if (session) {
        const explicit = rules.authorized_accounts[session.account_id];
        if (explicit) return explicit.role;

        if (workspace_role) return workspace_role;
    }

    return rules.default_role;
}

const READABLE_ROLES: ReadonlySet<AuthorizationRole> = new Set([
    'owner',
    'admin',
    'editor',
    'checker',
    'viewer',
]);

const EDITABLE_ROLES: ReadonlySet<AuthorizationRole> = new Set([
    'owner',
    'admin',
    'editor',
]);

export function canRead(role: AuthorizationRole): boolean {
    return READABLE_ROLES.has(role);
}

export function canEdit(role: AuthorizationRole): boolean {
    return EDITABLE_ROLES.has(role);
}
