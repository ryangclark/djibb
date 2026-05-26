import {
    CreateWorkspaceRequest,
    SLUG_PATTERN,
    UpdateWorkspaceRequest,
    Workspace,
    WorkspaceMember,
    WorkspaceSchema,
    WorkspaceWithMembership,
} from './index';
import { AuthorizationRoleEnum } from '../auth/rules';
import type { AuthorizationRole } from '../auth/rules';
import {
    BadRequestError,
    FailedPreconditionError,
    NotFoundError,
    ParseError,
    UnauthorizedError,
    UnexpectedError,
} from '../errors';
import { newId } from '../id';
import { Account } from '../account';
import { customAlphabet } from 'nanoid';
import type { DjibbList } from '../list/durable_object';
import type { PushRequestV1 } from 'replicache';

const slugSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

const RESERVED_SLUGS = new Set([
    'admin',
    'api',
    'invitations',
    'invites',
    'members',
    'new',
    'settings',
    'workspace',
    'workspaces',
]);

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

export function assertSlugFormat(slug: string): void {
    if (!SLUG_PATTERN.test(slug)) {
        throw new BadRequestError(
            'Invalid slug: lowercase letters, numbers, and hyphens only (3–40 chars).'
        );
    }
    if (RESERVED_SLUGS.has(slug)) {
        throw new BadRequestError(`Slug "${slug}" is reserved.`);
    }
}

function personalSlugCandidate(account: Account): string {
    const base = (account.user_name ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (base.length >= 3 && base.length <= 40) return base;
    return `personal-${slugSuffix()}`;
}

function personalNameForAccount(account: Account): string | null {
    if (account.display_name && account.display_name.trim()) {
        return `${account.display_name.trim()}'s space`;
    }
    return null;
}

function shapeWorkspaceRow(row: any): Workspace {
    const parsed = WorkspaceSchema.safeParse({
        id: row.id,
        slug: row.slug,
        name: row.name,
        is_personal: row.is_personal === 1 || row.is_personal === true,
        flags: row.flags ?? null,
        image: row.image ?? null,
        time_created: new Date(row.time_created * 1000),
        time_deleted: row.time_deleted ? new Date(row.time_deleted * 1000) : null,
        time_updated: new Date(row.time_updated * 1000),
    });
    if (!parsed.success) {
        console.error('shapeWorkspaceRow parse error:', parsed.error.format());
        throw new ParseError();
    }
    return parsed.data;
}

function buildInsertWorkspaceStatement(
    d1: D1Database,
    workspace: Workspace
): D1PreparedStatement {
    return d1
        .prepare(
            `INSERT INTO workspaces (
                id, slug, name, is_personal, flags, image,
                time_created, time_updated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
            workspace.id,
            workspace.slug,
            workspace.name,
            workspace.is_personal ? 1 : 0,
            workspace.flags,
            workspace.image,
            Math.floor(workspace.time_created.getTime() / 1000),
            Math.floor(workspace.time_updated.getTime() / 1000)
        );
}

function buildInsertMembershipStatement(
    d1: D1Database,
    workspaceId: string,
    accountId: string,
    role: AuthorizationRole,
    joinedAt: Date
): D1PreparedStatement {
    return d1
        .prepare(
            `INSERT INTO AccountWorkspace (
                account_id, workspace_id, role, permissions, time_joined
            ) VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
            accountId,
            workspaceId,
            role,
            null,
            Math.floor(joinedAt.getTime() / 1000)
        );
}

/**
 * Returns prepared statements to insert a personal workspace + owner
 * membership for the given account. Caller batches alongside its own
 * statements (e.g. account creation) for atomicity.
 */
export function buildPersonalWorkspaceStatements(
    d1: D1Database,
    account: Account
): { workspace: Workspace; statements: D1PreparedStatement[] } {
    const now = new Date();
    const workspace: Workspace = {
        id: newId('workspace'),
        slug: personalSlugCandidate(account),
        name: personalNameForAccount(account),
        is_personal: true,
        flags: null,
        image: null,
        time_created: now,
        time_deleted: null,
        time_updated: now,
    };
    return {
        workspace,
        statements: [
            buildInsertWorkspaceStatement(d1, workspace),
            buildInsertMembershipStatement(
                d1,
                workspace.id,
                account.id,
                'owner',
                now
            ),
        ],
    };
}

/**
 * ADR 0011 §Step 6: mint the personal workspace as a DjibbList entity
 * DO with `slot: 'personal_workspace'`. Called from `CreateAccount`
 * alongside the legacy `buildPersonalWorkspaceStatements` D1 writes
 * (dual-write transition).
 *
 * Synthesizes a Replicache push containing one `createWorkspace`
 * mutation and dispatches it through the DO's `handlePush`. The
 * client group / client IDs are derived from the account id so retries
 * of the same signup converge on the same Replicache state instead of
 * accumulating ghost client rows.
 *
 * Authoritative role passed in is `ownerless` — the DO has no rules
 * yet at mint time, so the resolver's default applies; createWorkspace
 * is gated on `EDIT_ROLES` which includes ownerless.
 *
 * Returns nothing; failures propagate. CreateAccount catches and
 * downgrades to a non-fatal log (see comment there).
 */
export async function mintPersonalWorkspaceEntity(
    djibbList: DurableObjectNamespace<DjibbList>,
    args: {
        accountId: string;
        workspaceId: string;
        name: string;
    }
): Promise<void> {
    const stub = djibbList.get(djibbList.idFromName(args.workspaceId));

    const pushRequest: PushRequestV1 = {
        profileID: 'p_signup',
        clientGroupID: `cg_signup_${args.accountId}`,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID: `c_signup_${args.accountId}`,
                id: 1,
                name: 'createWorkspace',
                timestamp: Date.now(),
                args: {
                    accountId: args.accountId,
                    timestamp_client: new Date().toISOString(),
                    workspaceId: args.workspaceId,
                    name: args.name,
                    slot: 'personal_workspace',
                } as any,
            },
        ],
    };

    const result = await stub.handlePush({
        authorizedAccounts: [{ id: args.accountId } as any],
        authorizedRole: 'ownerless',
        listId: args.workspaceId,
        pushRequest,
    });
    if (result.error) {
        throw new Error(
            `mintPersonalWorkspaceEntity: handlePush returned error: ${String(
                result.error
            )}`
        );
    }
}

export async function CreateWorkspace(
    d1: D1Database,
    actorAccountId: string,
    body: CreateWorkspaceRequest
): Promise<Workspace> {
    assertSlugFormat(body.slug);

    const now = new Date();
    const workspace: Workspace = {
        id: newId('workspace'),
        slug: body.slug,
        name: body.name,
        is_personal: false,
        flags: null,
        image: null,
        time_created: now,
        time_deleted: null,
        time_updated: now,
    };

    try {
        await d1.batch([
            buildInsertWorkspaceStatement(d1, workspace),
            buildInsertMembershipStatement(
                d1,
                workspace.id,
                actorAccountId,
                'owner',
                now
            ),
        ]);
    } catch (err: any) {
        if (String(err?.message ?? '').includes('UNIQUE')) {
            throw new BadRequestError('Slug already in use.');
        }
        console.error('CreateWorkspace error:', err);
        throw new UnexpectedError();
    }

    return workspace;
}

export async function GetWorkspaceBySlug(
    d1: D1Database,
    slug: string
): Promise<Workspace> {
    const row = await d1
        .prepare(
            `SELECT * FROM workspaces WHERE slug = ? AND time_deleted IS NULL LIMIT 1`
        )
        .bind(slug)
        .first();
    if (!row) throw new NotFoundError();
    return shapeWorkspaceRow(row);
}

export async function GetWorkspaceById(
    d1: D1Database,
    id: string
): Promise<Workspace> {
    const row = await d1
        .prepare(`SELECT * FROM workspaces WHERE id = ? LIMIT 1`)
        .bind(id)
        .first();
    if (!row) throw new NotFoundError();
    return shapeWorkspaceRow(row);
}

export async function GetWorkspacesByAccountId(
    d1: D1Database,
    accountId: string
): Promise<WorkspaceWithMembership[]> {
    const result = await d1
        .prepare(
            `SELECT
                w.id, w.slug, w.name, w.is_personal, w.flags, w.image,
                w.time_created, w.time_deleted, w.time_updated,
                aw.role, aw.permissions, aw.time_joined
            FROM workspaces w
            JOIN AccountWorkspace aw ON aw.workspace_id = w.id
            WHERE aw.account_id = ? AND w.time_deleted IS NULL
            ORDER BY w.is_personal DESC, w.time_created ASC`
        )
        .bind(accountId)
        .all();

    if (!result.success) {
        console.error('GetWorkspacesByAccountId query failed');
        throw new UnexpectedError();
    }

    return (result.results as any[]).map(row => ({
        workspace: shapeWorkspaceRow(row),
        membership: {
            account_id: accountId,
            role: AuthorizationRoleEnum.parse(row.role),
            permissions: row.permissions ? JSON.parse(row.permissions) : [],
            time_joined: new Date(row.time_joined * 1000),
        },
    }));
}

export async function GetWorkspaceMembers(
    d1: D1Database,
    workspaceId: string
): Promise<WorkspaceMember[]> {
    const result = await d1
        .prepare(
            `SELECT account_id, role, permissions, time_joined
            FROM AccountWorkspace
            WHERE workspace_id = ?`
        )
        .bind(workspaceId)
        .all();
    if (!result.success) throw new UnexpectedError();
    return (result.results as any[]).map(row => ({
        account_id: row.account_id,
        role: AuthorizationRoleEnum.parse(row.role),
        permissions: row.permissions ? JSON.parse(row.permissions) : [],
        time_joined: new Date(row.time_joined * 1000),
    }));
}

/**
 * Returns the actor's role in a workspace, or null if not a member.
 * Used by middleware and authorization checks.
 */
export async function GetMembership(
    d1: D1Database,
    accountId: string,
    workspaceId: string
): Promise<WorkspaceMember | null> {
    const row = await d1
        .prepare(
            `SELECT account_id, role, permissions, time_joined
            FROM AccountWorkspace
            WHERE account_id = ? AND workspace_id = ? LIMIT 1`
        )
        .bind(accountId, workspaceId)
        .first();
    if (!row) return null;
    return {
        account_id: (row as any).account_id,
        role: AuthorizationRoleEnum.parse((row as any).role),
        permissions: (row as any).permissions
            ? JSON.parse((row as any).permissions)
            : [],
        time_joined: new Date((row as any).time_joined * 1000),
    };
}

function requireRole(
    actual: AuthorizationRole,
    allowed: AuthorizationRole[]
): void {
    if (!allowed.includes(actual)) {
        throw new UnauthorizedError(
            `Requires one of: ${allowed.join(', ')}; have: ${actual}`
        );
    }
}

export async function UpdateWorkspace(
    d1: D1Database,
    actorAccountId: string,
    slug: string,
    patch: UpdateWorkspaceRequest
): Promise<Workspace> {
    const workspace = await GetWorkspaceBySlug(d1, slug);
    const membership = await GetMembership(d1, actorAccountId, workspace.id);
    if (!membership) throw new UnauthorizedError('Not a member.');
    requireRole(membership.role, ['owner', 'admin']);

    if (patch.slug && patch.slug !== workspace.slug) {
        assertSlugFormat(patch.slug);
    }

    const fields: string[] = [];
    const bindings: any[] = [];
    if (patch.slug !== undefined) {
        fields.push('slug = ?');
        bindings.push(patch.slug);
    }
    if (patch.name !== undefined) {
        fields.push('name = ?');
        bindings.push(patch.name);
    }
    if (patch.image !== undefined) {
        fields.push('image = ?');
        bindings.push(patch.image);
    }
    if (!fields.length) return workspace;

    fields.push('time_updated = ?');
    bindings.push(nowSec());
    bindings.push(workspace.id);

    try {
        await d1
            .prepare(`UPDATE workspaces SET ${fields.join(', ')} WHERE id = ?`)
            .bind(...bindings)
            .run();
    } catch (err: any) {
        if (String(err?.message ?? '').includes('UNIQUE')) {
            throw new BadRequestError('Slug already in use.');
        }
        console.error('UpdateWorkspace error:', err);
        throw new UnexpectedError();
    }

    return GetWorkspaceById(d1, workspace.id);
}

export async function SoftDeleteWorkspace(
    d1: D1Database,
    actorAccountId: string,
    slug: string
): Promise<void> {
    const workspace = await GetWorkspaceBySlug(d1, slug);
    if (workspace.is_personal) {
        throw new FailedPreconditionError(
            'Personal workspaces cannot be deleted.'
        );
    }
    const membership = await GetMembership(d1, actorAccountId, workspace.id);
    if (!membership) throw new UnauthorizedError('Not a member.');
    requireRole(membership.role, ['owner']);

    await d1
        .prepare(`UPDATE workspaces SET time_deleted = ? WHERE id = ?`)
        .bind(nowSec(), workspace.id)
        .run();
}

/**
 * Change a member's role. Admin+ required. The actor cannot demote
 * themselves below `owner` if they're the last owner. Owners can
 * promote/demote anyone except in ways that would leave the workspace
 * with zero owners. Admins cannot create or remove owners.
 */
export async function ChangeMemberRole(
    d1: D1Database,
    actorAccountId: string,
    slug: string,
    targetAccountId: string,
    newRole: AuthorizationRole
): Promise<WorkspaceMember> {
    const workspace = await GetWorkspaceBySlug(d1, slug);
    if (workspace.is_personal) {
        throw new FailedPreconditionError(
            'Personal workspaces have no role changes.'
        );
    }
    const actor = await GetMembership(d1, actorAccountId, workspace.id);
    if (!actor) throw new UnauthorizedError('Not a member.');
    requireRole(actor.role, ['owner', 'admin']);

    const target = await GetMembership(d1, targetAccountId, workspace.id);
    if (!target) throw new NotFoundError('Member not found.');

    // Admins cannot touch owners or grant ownership.
    if (
        actor.role === 'admin' &&
        (target.role === 'owner' || newRole === 'owner')
    ) {
        throw new UnauthorizedError(
            'Admins cannot change owner roles or grant ownership.'
        );
    }

    // If demoting an owner, ensure at least one owner remains.
    if (target.role === 'owner' && newRole !== 'owner') {
        const members = await GetWorkspaceMembers(d1, workspace.id);
        const owners = members.filter(m => m.role === 'owner');
        if (owners.length <= 1) {
            throw new FailedPreconditionError(
                'Cannot demote the last owner.'
            );
        }
    }

    if (target.role === newRole) return target; // no-op

    await d1
        .prepare(
            `UPDATE AccountWorkspace SET role = ?
             WHERE account_id = ? AND workspace_id = ?`
        )
        .bind(newRole, targetAccountId, workspace.id)
        .run();

    return { ...target, role: newRole };
}

/**
 * Remove a member from a workspace. Admin+ required. Cannot remove
 * the last owner. Members can leave themselves via LeaveWorkspace; this
 * endpoint is for admin-initiated removal.
 */
export async function RemoveMember(
    d1: D1Database,
    actorAccountId: string,
    slug: string,
    targetAccountId: string
): Promise<void> {
    const workspace = await GetWorkspaceBySlug(d1, slug);
    if (workspace.is_personal) {
        throw new FailedPreconditionError(
            'Personal workspaces have a single member.'
        );
    }
    const actor = await GetMembership(d1, actorAccountId, workspace.id);
    if (!actor) throw new UnauthorizedError('Not a member.');
    requireRole(actor.role, ['owner', 'admin']);

    const target = await GetMembership(d1, targetAccountId, workspace.id);
    if (!target) throw new NotFoundError('Member not found.');

    // Admins cannot remove owners.
    if (actor.role === 'admin' && target.role === 'owner') {
        throw new UnauthorizedError('Admins cannot remove owners.');
    }

    if (target.role === 'owner') {
        const members = await GetWorkspaceMembers(d1, workspace.id);
        const owners = members.filter(m => m.role === 'owner');
        if (owners.length <= 1) {
            throw new FailedPreconditionError(
                'Cannot remove the last owner.'
            );
        }
    }

    await d1
        .prepare(
            `DELETE FROM AccountWorkspace
             WHERE account_id = ? AND workspace_id = ?`
        )
        .bind(targetAccountId, workspace.id)
        .run();
}

export async function LeaveWorkspace(
    d1: D1Database,
    actorAccountId: string,
    slug: string
): Promise<void> {
    const workspace = await GetWorkspaceBySlug(d1, slug);
    if (workspace.is_personal) {
        throw new FailedPreconditionError(
            'Personal workspaces cannot be left.'
        );
    }
    const membership = await GetMembership(d1, actorAccountId, workspace.id);
    if (!membership) throw new NotFoundError('Not a member.');

    if (membership.role === 'owner') {
        const members = await GetWorkspaceMembers(d1, workspace.id);
        const owners = members.filter(m => m.role === 'owner');
        if (owners.length <= 1) {
            throw new FailedPreconditionError(
                'You are the last owner. Transfer ownership before leaving.'
            );
        }
    }

    await d1
        .prepare(
            `DELETE FROM AccountWorkspace WHERE account_id = ? AND workspace_id = ?`
        )
        .bind(actorAccountId, workspace.id)
        .run();
}
