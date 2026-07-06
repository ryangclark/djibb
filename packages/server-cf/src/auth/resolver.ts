/**
 * Role resolution — the one module that answers "what role does this
 * request hold on this entity?"
 *
 * The interface is two operations plus the guards built on their output:
 *
 * - {@link resolveRequestRole}: principal + entity rules → role. Owns the
 *   whole ladder — per-account specificity, workspace-membership lookup,
 *   and cross-account selection (the `X-Djibb-Active-Account` tiebreak,
 *   passed in as `activeAccountId` by the HTTP adapter).
 * - {@link resolvePreInitRole}: the sibling question for entity-*creating*
 *   pushes — "may you create as this identity?" — where no rules exist
 *   yet to resolve against.
 *
 * Both are context-free (no Hono `Context`) and take their D1 access as an
 * injected {@link RoleResolutionDeps}, mirroring `resolvePrincipal` and
 * the DO preflights: the module is the testable surface, the route file
 * is a thin adapter.
 */
import type {
    AuthorizationRole,
    AuthorizationRules,
} from '@djibb/protocol/auth/rules';
import { UnauthorizedError } from './errors';
import { principalAccounts, type RequestPrincipal } from './principal';

/**
 * The module's one dependency: the workspace-membership lookup, reading
 * the `entity_memberships` Derived Index (owned by `derived-index/d1.ts`
 * per ADR 0025). Injected so the ladder is unit-testable with a stub.
 */
export type RoleResolutionDeps = {
    /** The account's role in a workspace, or null if not a member. */
    getMembershipRole(
        accountId: string,
        workspaceId: string,
    ): Promise<AuthorizationRole | null>;
};

type Session = { account_id: string } | null;

/**
 * Per-account specificity ladder (highest to lowest):
 *   1. authorized_accounts[account_id] — explicit per-entity grant or
 *      demotion; wins both directions (it can grant above workspace
 *      membership *and* demote a workspace admin to `restricted` on a
 *      sensitive entity)
 *   2. workspace membership — passed through as-is (ADR 0011 §Step 4:
 *      memberships carry `AuthorizationRole` directly)
 *   3. default_role — the floor for anyone else (including anonymous)
 *
 * Internal: callers go through {@link resolveRequestRole}, which layers
 * cross-account selection on top.
 */
function resolveRole(
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

/**
 * Resolves the role a request holds on one entity: every account the
 * principal carries runs the per-account ladder, then cross-account
 * selection picks the acting one (explicit > workspace > default source
 * specificity; `activeAccountId` — the `X-Djibb-Active-Account` header,
 * pre-extracted but unvalidated — breaks ties within the winning level
 * and is ignored unless it names an account the principal holds).
 *
 * The membership lookup is skipped for accounts with an explicit entry
 * (the ladder can't reach it) and when the entity has no workspace.
 */
export async function resolveRequestRole(
    deps: RoleResolutionDeps,
    input: {
        principal: RequestPrincipal;
        activeAccountId: string | null;
        rules: AuthorizationRules;
        workspaceId: string | null;
    },
): Promise<AuthorizationRole> {
    const { rules, workspaceId } = input;
    const accounts = principalAccounts(input.principal);

    const activeAccountId = input.activeAccountId
        ? accounts.find(a => a.id === input.activeAccountId)?.id ?? null
        : null;

    type Candidate = {
        accountId: string;
        role: AuthorizationRole;
        source: 'explicit' | 'workspace' | 'default';
    };
    const candidates: Candidate[] = [];

    for (const account of accounts) {
        const hasExplicit = rules.authorized_accounts[account.id] != null;
        let workspaceRole = null;
        if (!hasExplicit && workspaceId) {
            workspaceRole = await deps.getMembershipRole(
                account.id,
                workspaceId,
            );
        }
        candidates.push({
            accountId: account.id,
            role: resolveRole({ account_id: account.id }, rules, workspaceRole),
            source: hasExplicit
                ? 'explicit'
                : workspaceRole
                ? 'workspace'
                : 'default',
        });
    }

    function pickByActive(level: Candidate[]): Candidate {
        return (
            (activeAccountId
                ? level.find(c => c.accountId === activeAccountId)
                : undefined) ?? level[0]!
        );
    }

    const explicit = candidates.filter(c => c.source === 'explicit');
    const workspace = candidates.filter(c => c.source === 'workspace');
    if (explicit.length) return pickByActive(explicit).role;
    if (workspace.length) return pickByActive(workspace).role;
    return resolveRole(null, rules, null);
}

/**
 * The sibling operation for entity-creating pushes (`initList` /
 * `mintFromBlank` on an id with no D1 row yet): there are no prior rules
 * to resolve against, so the question is "may you *create* as this
 * identity?" — the principal must own any claimed account, and a claimed
 * workspace requires a claimed account with membership in it. The caller
 * is the owner-to-be (if an account is claimed) or an anonymous editor
 * of an ownerless entity.
 *
 * Throws {@link UnauthorizedError} on any claim the principal can't back.
 */
export async function resolvePreInitRole(
    deps: RoleResolutionDeps,
    input: {
        principal: RequestPrincipal;
        claimedAccountId: string | null;
        claimedWorkspaceId: string | null;
    },
): Promise<'owner' | 'ownerless'> {
    const accounts = principalAccounts(input.principal);

    if (input.claimedAccountId) {
        const ownsAccount = accounts.some(
            a => a.id === input.claimedAccountId,
        );
        if (!ownsAccount) throw new UnauthorizedError();
    }
    if (input.claimedWorkspaceId) {
        if (!input.claimedAccountId) throw new UnauthorizedError();
        const membership = await deps.getMembershipRole(
            input.claimedAccountId,
            input.claimedWorkspaceId,
        );
        if (!membership) throw new UnauthorizedError();
    }

    return input.claimedAccountId ? 'owner' : 'ownerless';
}

/**
 * The read view-floor (ADR 0021 §Decision 1, issue #13). A role at or
 * above the floor sees entity content in `handlePull`; `restricted` and
 * `submitter` sit *below* it and receive an empty content patch (not a
 * 403). `ownerless` is **above** the floor — anonymous-created Blanks
 * (`default_role: 'ownerless'`, e.g. the contributed Lists) must stay
 * publicly readable, so this set matches the ADR's `VIEW_ROLES`
 * (owner | admin | editor | checker | viewer | ownerless), NOT the
 * narrower `AccountRoleEnum`. `system` is a cluster-internal cascade
 * identity that also reads (it mutates content, so it must see it).
 */
const READABLE_ROLES: ReadonlySet<AuthorizationRole> = new Set([
    'owner',
    'admin',
    'editor',
    'checker',
    'viewer',
    'ownerless',
    'system',
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
