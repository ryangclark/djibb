import {
    type Workspace,
    type WorkspaceMember,
    WorkspaceSchema,
    type WorkspaceWithMembership,
} from './index';
import { AuthorizationRoleEnum } from '@djibb/protocol/auth/rules';
import { ParseError } from '@djibb/protocol/errors';
import { newId } from '@djibb/protocol/id';
import {
    GetMembershipRow,
    GetWorkspaceRowsForAccount,
    type WorkspaceForAccountRow,
} from '../derived-index/d1';
import type { Account } from '@djibb/protocol/account';
import type { DjibbList } from '../list/durable_object';
import type { PushRequestV1 } from 'replicache';

/**
 * ADR 0011 §7b.4: the legacy D1-backed workspace write surface
 * (`CreateWorkspace`, `UpdateWorkspace`, `SoftDeleteWorkspace`,
 * `ChangeMemberRole`, `RemoveMember`, `LeaveWorkspace`,
 * `GetWorkspaceBySlug`, `GetWorkspaceById`, `GetWorkspaceMembers`,
 * `assertSlugFormat`, `RESERVED_SLUGS`, `requireRole`, `shapeWorkspaceRow`)
 * is gone. Workspace mutations now dispatch through DjibbList DO
 * mutators (`createWorkspace`, `renameWorkspace`, `setWorkspaceImage`,
 * `changeMemberRole`, `removeMember`, `leaveMember`) via Replicache.
 * Member reads come off the entity's `authorization_rules.authorized_accounts`
 * via the workspace's own Replicache client. What remains here are the
 * D1-projection read paths (`GetWorkspacesByAccountId`, `GetMembership`)
 * and the signup-time `mintPersonalWorkspaceEntity` synth-push helper.
 */

function personalNameForAccount(account: Account): string | null {
    if (account.display_name && account.display_name.trim()) {
        return `${account.display_name.trim()}'s space`;
    }
    return null;
}

/**
 * ADR 0011 §Step 7b.1: mint the personal workspace as a DjibbList entity
 * DO with `slot: 'personal_workspace'`. The DO is the sole source of
 * truth for the workspace (the legacy `workspaces` + `AccountWorkspace`
 * tables were dropped in §7b.6), so this call is fatal-on-failure from
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
 * Slug is the id suffix at mint (the `defaultSlugForId` default written
 * by `createWorkspace`); owners can rename it later via `setWorkspaceSlug`
 * — see ADR 0011 §Step 7b.5.
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

/**
 * Synthesize a `Workspace` view from a `workspace_entities` row +
 * `entity_memberships` join. Slug comes from the real D1 column (ADR
 * 0011 §Step 7b.5); it equals the id suffix for un-customized
 * workspaces and a user-chosen string after `setWorkspaceSlug`.
 * Image / flags come from the `meta` JSON blob.
 */
function shapeEntityWorkspaceRow(row: WorkspaceForAccountRow): Workspace {
    let meta: any = null;
    if (row.meta) {
        try {
            meta = JSON.parse(row.meta);
        } catch {
            meta = null;
        }
    }
    const parsed = WorkspaceSchema.safeParse({
        id: row.id,
        slug: row.slug,
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
    // projection joined with the catalog (Derived Index, ADR 0025).
    const rows = await GetWorkspaceRowsForAccount(d1, accountId);
    return rows.map(row => ({
        workspace: shapeEntityWorkspaceRow(row),
        membership: {
            account_id: accountId,
            role: AuthorizationRoleEnum.parse(row.role),
            permissions: [],
            time_joined: new Date(row.time_joined * 1000),
        },
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
    const row = await GetMembershipRow(d1, accountId, workspaceId);
    if (!row) return null;
    return {
        account_id: row.account_id,
        role: AuthorizationRoleEnum.parse(row.role),
        permissions: [],
        time_joined: new Date(row.time_joined * 1000),
    };
}

