import { Hono } from 'hono';
import { HonoEnv } from '..';
import { HandleSession } from '../auth/middleware';
import {
    BadRequestError,
    UnauthenticatedError,
} from '../errors';
import {
    CreateWorkspace,
    GetWorkspaceBySlug,
    GetWorkspaceMembers,
    LeaveWorkspace,
    SoftDeleteWorkspace,
    UpdateWorkspace,
} from './service';
import {
    CreateWorkspaceRequestSchema,
    UpdateWorkspaceRequestSchema,
} from './index';
import { Session } from '../auth/session';

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
        const match = session.accounts.find(a => a.id === headerId);
        if (!match) {
            throw new BadRequestError(
                `Active-account header "${headerId}" is not in the current session.`
            );
        }
        return match.id;
    }
    // Fallback: first authed account.
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
