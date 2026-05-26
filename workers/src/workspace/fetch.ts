import { Hono } from 'hono';
import { z } from 'zod';
import { HonoEnv } from '..';
import { HandleSession } from '../auth/middleware';
import {
    BadRequestError,
    UnauthenticatedError,
} from '../errors';
import {
    ChangeMemberRole,
    CreateWorkspace,
    GetWorkspaceBySlug,
    GetWorkspaceMembers,
    LeaveWorkspace,
    RemoveMember,
    SoftDeleteWorkspace,
    UpdateWorkspace,
} from './service';
import {
    CreateWorkspaceRequestSchema,
    UpdateWorkspaceRequestSchema,
} from './index';
import { Session } from '../auth/session';

// ADR 0011 §7b.3: the legacy `InvitationApp` (token-based, multi-type
// workspace invitations backed by the `workspace_invitations` table)
// was deleted. Invitations now go through the ADR 0009 entity-resident
// `inviteByIdentity`/`acceptInvitation` mutators on the DjibbList DO.
// `WorkspaceApp` keeps the legacy member-management endpoints — those
// collapse onto DO mutator dispatch in 7b.4.

export const WorkspaceApp = new Hono<HonoEnv>();

WorkspaceApp.use('*', HandleSession);

const ACTIVE_ACCOUNT_HEADER = 'X-Djibb-Active-Account';

function requireSession(session: Session | null): Session {
    if (!session) throw new UnauthenticatedError();
    return session;
}

function resolveActorAccountId(c: any): string {
    const session = requireSession(c.get('session'));
    if (!session.accounts.length) throw new UnauthenticatedError();

    const headerId = c.req.header(ACTIVE_ACCOUNT_HEADER);
    if (headerId) {
        const match = session.accounts.find((a: any) => a.id === headerId);
        if (!match) {
            throw new BadRequestError(
                `Active-account header "${headerId}" is not in the current session.`
            );
        }
        return match.id;
    }
    return session.accounts[0]!.id;
}

WorkspaceApp.post('/', async c => {
    const actorId = resolveActorAccountId(c);
    const body = await c.req.json().catch(() => {
        throw new BadRequestError('Invalid JSON body.');
    });
    const parsed = CreateWorkspaceRequestSchema.safeParse(body);
    if (!parsed.success) {
        throw new BadRequestError(
            `Invalid request: ${JSON.stringify(parsed.error.format())}`
        );
    }
    const workspace = await CreateWorkspace(c.env.DJIBB_AUTH, actorId, parsed.data);
    return c.json(workspace);
});

WorkspaceApp.get('/:slug', async c => {
    requireSession(c.get('session'));
    const workspace = await GetWorkspaceBySlug(c.env.DJIBB_AUTH, c.req.param('slug'));
    return c.json(workspace);
});

WorkspaceApp.patch('/:slug', async c => {
    const actorId = resolveActorAccountId(c);
    const body = await c.req.json().catch(() => {
        throw new BadRequestError('Invalid JSON body.');
    });
    const parsed = UpdateWorkspaceRequestSchema.safeParse(body);
    if (!parsed.success) {
        throw new BadRequestError(
            `Invalid request: ${JSON.stringify(parsed.error.format())}`
        );
    }
    const workspace = await UpdateWorkspace(
        c.env.DJIBB_AUTH,
        actorId,
        c.req.param('slug'),
        parsed.data
    );
    return c.json(workspace);
});

WorkspaceApp.delete('/:slug', async c => {
    const actorId = resolveActorAccountId(c);
    await SoftDeleteWorkspace(c.env.DJIBB_AUTH, actorId, c.req.param('slug'));
    return c.body(null, 204);
});

WorkspaceApp.post('/:slug/leave', async c => {
    const actorId = resolveActorAccountId(c);
    await LeaveWorkspace(c.env.DJIBB_AUTH, actorId, c.req.param('slug'));
    return c.body(null, 204);
});

WorkspaceApp.get('/:slug/members', async c => {
    requireSession(c.get('session'));
    const workspace = await GetWorkspaceBySlug(c.env.DJIBB_AUTH, c.req.param('slug'));
    const members = await GetWorkspaceMembers(c.env.DJIBB_AUTH, workspace.id);
    return c.json(members);
});

/**
 * Valid roles for the change-role surface. The narrower subset of
 * `AuthorizationRoleEnum` that's meaningful at the membership level —
 * `'restricted'` and `'ownerless'` are entity-level concepts that don't
 * belong on a workspace member. `'checker'` is omitted from the UI for
 * now; can be added back when the workspace membership UX expects it.
 */
const PatchMemberSchema = z.object({
    role: z.enum(['owner', 'admin', 'editor', 'viewer']),
});

WorkspaceApp.patch('/:slug/members/:accountId', async c => {
    const actorId = resolveActorAccountId(c);
    const body = await c.req.json().catch(() => {
        throw new BadRequestError('Invalid JSON body.');
    });
    const parsed = PatchMemberSchema.safeParse(body);
    if (!parsed.success) {
        throw new BadRequestError(
            `Invalid request: ${JSON.stringify(parsed.error.format())}`
        );
    }
    const updated = await ChangeMemberRole(
        c.env.DJIBB_AUTH,
        actorId,
        c.req.param('slug'),
        c.req.param('accountId'),
        parsed.data.role
    );
    return c.json(updated);
});

WorkspaceApp.delete('/:slug/members/:accountId', async c => {
    const actorId = resolveActorAccountId(c);
    await RemoveMember(
        c.env.DJIBB_AUTH,
        actorId,
        c.req.param('slug'),
        c.req.param('accountId')
    );
    return c.body(null, 204);
});

