import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoEnv } from '..';
import { HandleSession } from '../auth/middleware';
import { GetWorkspacesByAccountId } from '../workspace/service';
import { ListTrashedEntitiesForAccount } from '../catalog/service';
import { BadRequestError, UnauthenticatedError, UnauthorizedError } from '../errors';
import { IdTypes } from '../id';
import { GetAccountByUsername, SetAccountUsername } from './username';

export const AccountApp = new Hono<HonoEnv>();
export const UserApp = new Hono<HonoEnv>();

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

/**
 * Trash listing for one account. Same URL convention as `/workspaces`:
 * `/a/<suffix>/trash`. Returns the soft-deleted entities (workspaces,
 * plus lists/templates with `cascade_source IS NULL`) the actor owns.
 * Per ADR 0008 / ADR 0011 §Step 10b-ui.
 */
AccountApp.get('/:suffix/trash', async c => {
    const session = c.get('session');
    if (!session) throw new UnauthenticatedError();

    const accountId = `${IdTypes.account}/${c.req.param('suffix')}`;
    if (!session.accounts.some(a => a.id === accountId)) {
        throw new UnauthorizedError(
            'Account is not part of the current session.'
        );
    }

    const entities = await ListTrashedEntitiesForAccount(
        c.env.DJIBB_AUTH,
        accountId
    );
    return c.json(entities);
});

const PatchAccountSchema = z.object({
    user_name: z.string().min(1).max(64),
});

/**
 * Set or change the username for an account. Actor must own the
 * account (it must appear in their session).
 */
AccountApp.patch('/:suffix', async c => {
    const session = c.get('session');
    if (!session) throw new UnauthenticatedError();

    const accountId = `${IdTypes.account}/${c.req.param('suffix')}`;
    if (!session.accounts.some(a => a.id === accountId)) {
        throw new UnauthorizedError(
            'Account is not part of the current session.'
        );
    }

    const body = await c.req.json().catch(() => {
        throw new BadRequestError('Invalid JSON body.');
    });
    const parsed = PatchAccountSchema.safeParse(body);
    if (!parsed.success) {
        throw new BadRequestError(
            `Invalid request: ${JSON.stringify(parsed.error.format())}`
        );
    }

    const username = await SetAccountUsername(
        c.env.DJIBB_AUTH,
        accountId,
        parsed.data.user_name
    );

    return c.json({
        id: accountId,
        user_name: username,
        detail: `Your username is publicly visible at /u/${username}.`,
    });
});

/**
 * Public username lookup — no auth required. Used by invite-by-username
 * UX and any future @-mention feature.
 */
UserApp.get('/:username', async c => {
    const account = await GetAccountByUsername(
        c.env.DJIBB_AUTH,
        c.req.param('username')
    );
    if (!account) {
        return c.json({ error: 'Not found' }, 404);
    }
    return c.json(account);
});
