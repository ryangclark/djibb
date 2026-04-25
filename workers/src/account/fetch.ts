import { Hono } from 'hono';
import { HonoEnv } from '..';
import { HandleSession } from '../auth/middleware';
import { GetWorkspacesByAccountId } from '../workspace/service';
import { UnauthenticatedError, UnauthorizedError } from '../errors';
import { IdTypes } from '../id';

export const AccountApp = new Hono<HonoEnv>();

AccountApp.use('*', HandleSession);

/**
 * Mounted at `/a`, so the URL is `/a/:suffix/workspaces`. The full
 * account ID is `a/<suffix>` (the URL prefix mirrors the ID's type
 * prefix — IDs are self-describing).
 */
AccountApp.get('/:suffix/workspaces', async c => {
    const session = c.get('session');
    if (!session) throw new UnauthenticatedError();

    const accountId = `${IdTypes.account}/${c.req.param('suffix')}`;
    if (!session.accounts.some(a => a.id === accountId)) {
        throw new UnauthorizedError(
            'Account is not part of the current session.'
        );
    }

    const workspaces = await GetWorkspacesByAccountId(c.env.DJIBB_AUTH, accountId);
    return c.json(workspaces);
});
