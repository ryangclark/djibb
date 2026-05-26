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
import type { DjibbList } from '../list/durable_object';
import type { PushRequestV1 } from 'replicache';

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

function personalNameForAccount(account: Account): string | null {
    if (account.display_name && account.display_name.trim()) {
        return `${account.display_name.trim()}'s space`;
    }
    return null;
}

/**
 * ADR 0011 §Step 7b.1: mint the personal workspace as a DjibbList entity
 * DO with `slot: 'personal_workspace'`. The DO is now the sole source
 * of truth — the legacy `workspaces` + `AccountWorkspace` dual-write
 * was removed in 7b.1, so this call is fatal-on-failure from
 * `CreateAccount`'s perspective.
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
 * Slugs are postponed (see workspace/index.ts SLUG_PATTERN comment):
 * the entity is created with no slug; URL access goes via the id-suffix
 * route until slug support returns on the entity row.
 *
 * Returns the synthesized `workspaceId` so the caller can wire up
 * defaults (active-account, session.lastWorkspaceId, etc.) without
 * having to peek at DO state.
 */
export async function mintPersonalWorkspaceEntity(
    djibbList: DurableObjectNamespace<DjibbList>,
    account: Account
): Promise<{ workspaceId: string }> {
    const workspaceId = newId('workspace');
    const name = personalNameForAccount(account) ?? 'Personal';
    const stub = djibbList.get(djibbList.idFromName(workspaceId));

    const pushRequest: PushRequestV1 = {
        profileID: 'p_signup',
        clientGroupID: `cg_signup_${account.id}`,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
            {
                clientID: `c_signup_${account.id}`,
                id: 1,
                name: 'createWorkspace',
                timestamp: Date.now(),
                args: {
                    accountId: account.id,
                    timestamp_client: new Date().toISOString(),
                    workspaceId,
                    name,
                    slot: 'personal_workspace',
                } as any,
            },
        ],
    };

    const result = await stub.handlePush({
        authorizedAccounts: [{ id: account.id } as any],
        authorizedRole: 'ownerless',
        listId: workspaceId,
        pushRequest,
    });
    if (result.error) {
        throw new Error(
            `mintPersonalWorkspaceEntity: handlePush returned error: ${String(
                result.error
            )}`
        );
    }
    return { workspaceId };
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
            d1
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
                    0,
                    workspace.flags,
                    workspace.image,
                    Math.floor(workspace.time_created.getTime() / 1000),
                    Math.floor(workspace.time_updated.getTime() / 1000)
                ),
            d1
                .prepare(
                    `INSERT INTO AccountWorkspace (
                        account_id, workspace_id, role, permissions, time_joined
                    ) VALUES (?, ?, ?, ?, ?)`
                )
                .bind(
                    actorAccountId,
                    workspace.id,
                    'owner',
                    null,
                    Math.floor(now.getTime() / 1000)
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

/**
 * Synthesize a `Workspace` view from a `workspace_entities` row +
 * `entity_memberships` join. Slugs are postponed (ADR 0011 §7b notes);
 * for now the slug field carries the id suffix so existing slug-based
 * routes still return a stable token per entity. Image / flags come
 * from the `meta` JSON blob.
 */
function shapeEntityWorkspaceRow(row: any): Workspace {
    let meta: any = null;
    if (row.meta && typeof row.meta === 'string') {
        try {
            meta = JSON.parse(row.meta);
        } catch {
            meta = null;
        }
    }
    const id = String(row.id);
    const suffix = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
    const parsed = WorkspaceSchema.safeParse({
        id,
        slug: suffix,
        name: row.name ?? null,
        is_personal: row.slot === 'personal_workspace',
        flags: null,
        image: meta?.image_url ?? null,
        time_created: new Date(row.time_created * 1000),
        time_deleted: row.time_deleted
            ? new Date(row.time_deleted * 1000)
            : null,
        time_updated: new Date(row.time_updated * 1000),
    });
    if (!parsed.success) {
        console.error(
            'shapeEntityWorkspaceRow parse error:',
            parsed.error.format()
        );
        throw new ParseError();
    }
    return parsed.data;
}

export async function GetWorkspacesByAccountId(
    d1: D1Database,
    accountId: string
): Promise<WorkspaceWithMembership[]> {
    // ADR 0011 §Step 7b.2: read from the entity-resident membership
    // projection (`entity_memberships`) joined with `workspace_entities`
    // instead of the legacy `workspaces` + `AccountWorkspace` tables.
    const result = await d1
        .prepare(
            `SELECT
                we.id, we.name, we.slot, we.meta,
                we.time_created, we.time_deleted, we.time_updated,
                em.role, em.time_updated AS time_joined
            FROM entity_memberships em
            JOIN workspace_entities we ON we.id = em.entity_id
            WHERE em.account_id = ?
              AND we.type = 'workspace'
              AND we.time_deleted IS NULL
            ORDER BY (we.slot = 'personal_workspace') DESC, we.time_created ASC`
        )
        .bind(accountId)
        .all();

    if (!result.success) {
        console.error('GetWorkspacesByAccountId query failed');
        throw new UnexpectedError();
    }

    return (result.results as any[]).map(row => ({
        workspace: shapeEntityWorkspaceRow(row),
        membership: {
            account_id: accountId,
            role: AuthorizationRoleEnum.parse(row.role),
            permissions: [],
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
 *
 * ADR 0011 §Step 7b.2: reads from `entity_memberships` (the D1
 * projection of `authorization_rules.authorized_accounts` per ADR
 * 0011 §Step 7a). The DO is authoritative; this projection is
 * post-commit-emitted and reconciled by the alarm sweeper. The
 * `workspaceId` arg is an entity id — same column join as
 * `GetWorkspacesByAccountId`. `permissions` is always `[]` (legacy
 * column unused; the projection table doesn't carry it).
 */
export async function GetMembership(
    d1: D1Database,
    accountId: string,
    workspaceId: string
): Promise<WorkspaceMember | null> {
    const row = await d1
        .prepare(
            `SELECT account_id, role, time_updated AS time_joined
            FROM entity_memberships
            WHERE account_id = ? AND entity_id = ? LIMIT 1`
        )
        .bind(accountId, workspaceId)
        .first();
    if (!row) return null;
    return {
        account_id: (row as any).account_id,
        role: AuthorizationRoleEnum.parse((row as any).role),
        permissions: [],
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
