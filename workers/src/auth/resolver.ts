import type { AuthorizationRole, AuthorizationRules } from './rules';
import type { WorkspaceRole } from '../workspace';

export type Session = { account_id: string } | null;

const WORKSPACE_ROLE_TO_ENTITY_ROLE: Record<WorkspaceRole, AuthorizationRole> = {
    owner: 'owner',
    admin: 'admin',
    member: 'editor',
    viewer: 'viewer',
};

/**
 * Resolves the AuthorizationRole an account holds against a single entity.
 *
 * Specificity (highest to lowest):
 *   1. authorized_accounts[account_id] — explicit per-entity grant or demotion
 *   2. workspace membership — translated via WORKSPACE_ROLE_TO_ENTITY_ROLE
 *   3. default_role — the floor for anyone else (including anonymous)
 *
 * An explicit `authorized_accounts` entry wins both directions: it can grant
 * access above workspace membership *and* demote a workspace admin to
 * `restricted` on a sensitive entity.
 *
 * Pure: no I/O. Callers fetch rules and workspace_role and pass them in.
 */
export function resolveRole(
    session: Session,
    rules: AuthorizationRules,
    workspace_role: WorkspaceRole | null,
): AuthorizationRole {
    if (session) {
        const explicit = rules.authorized_accounts[session.account_id];
        if (explicit) return explicit.role;

        if (workspace_role) return WORKSPACE_ROLE_TO_ENTITY_ROLE[workspace_role];
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
