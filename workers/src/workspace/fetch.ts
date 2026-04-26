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
    AcceptInvitation,
    CreateInvitation,
    GetInvitationPreview,
    ListInvitations,
    RevokeInvitation,
} from './invitations';
import { sendInvitationEmail } from '../email';
import {
    CreateInvitationRequestSchema,
    CreateWorkspaceRequestSchema,
    InvitableRoleEnum,
    UpdateWorkspaceRequestSchema,
} from './index';
import { Session } from '../auth/session';

export const WorkspaceApp = new Hono<HonoEnv>();
export const InvitationApp = new Hono<HonoEnv>();

WorkspaceApp.use('*', HandleSession);
InvitationApp.use('*', HandleSession);

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

const PatchMemberSchema = z.object({
    role: z.enum(['owner', 'admin', 'member', 'viewer']),
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

WorkspaceApp.get('/:slug/invitations', async c => {
    const actorId = resolveActorAccountId(c);
    const list = await ListInvitations(
        c.env.DJIBB_AUTH,
        actorId,
        c.req.param('slug')
    );
    return c.json(list);
});

WorkspaceApp.post('/:slug/invitations', async c => {
    const actorId = resolveActorAccountId(c);
    const body = await c.req.json().catch(() => {
        throw new BadRequestError('Invalid JSON body.');
    });
    const parsed = CreateInvitationRequestSchema.safeParse(body);
    if (!parsed.success) {
        throw new BadRequestError(
            `Invalid request: ${JSON.stringify(parsed.error.format())}`
        );
    }
    const invitation = await CreateInvitation(
        c.env.DJIBB_AUTH,
        actorId,
        c.req.param('slug'),
        parsed.data
    );

    // Fire-and-forget email delivery for email-type invites. Failures
    // are logged but don't block the response — the invite still exists
    // in D1 and can be resent or copied as a link.
    if (invitation.type === 'email' && invitation.target_email) {
        const workspace = await GetWorkspaceBySlug(
            c.env.DJIBB_AUTH,
            c.req.param('slug')
        );
        const session = requireSession(c.get('session'));
        const inviter = session.accounts.find(a => a.id === actorId);
        const acceptUrl = `${c.env.AUTHORIZED_DOMAINS.split(';')[0]}/invites/${invitation.token}`;
        c.executionCtx.waitUntil(
            sendInvitationEmail(c.env, {
                to: invitation.target_email,
                workspaceName: workspace.name ?? 'a workspace',
                inviterName: inviter?.display_name ?? 'Someone',
                acceptUrl,
            }).catch(err =>
                console.error('sendInvitationEmail failed:', err)
            )
        );
    }

    return c.json(invitation);
});

WorkspaceApp.delete('/:slug/invitations/:id', async c => {
    const actorId = resolveActorAccountId(c);
    await RevokeInvitation(
        c.env.DJIBB_AUTH,
        actorId,
        c.req.param('slug'),
        c.req.param('id')
    );
    return c.body(null, 204);
});

/**
 * Public preview of an invitation. Tokenized — anyone with the URL can
 * see the workspace name and inviter, but not the membership list.
 */
InvitationApp.get('/:token', async c => {
    const preview = await GetInvitationPreview(
        c.env.DJIBB_AUTH,
        c.req.param('token')
    );
    return c.json(preview);
});

InvitationApp.post('/:token/accept', async c => {
    const actorId = resolveActorAccountId(c);
    const result = await AcceptInvitation(
        c.env.DJIBB_AUTH,
        actorId,
        c.req.param('token')
    );
    return c.json(result);
});
