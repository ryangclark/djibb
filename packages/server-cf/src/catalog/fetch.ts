import { Hono } from 'hono';

import type { HonoEnv } from '..';

import { HandleSession } from '../auth/middleware';
import { UnauthenticatedError, UnauthorizedError } from '@djibb/protocol/errors';
import { ListOwnedEntities } from './service';

const ACTIVE_ACCOUNT_HEADER = 'X-Djibb-Active-Account';

export const CatalogApp = new Hono<HonoEnv>();

CatalogApp.use('*', HandleSession);

/**
 * Owner-only entity catalog for one account.
 *
 * The active-account header pins which account the picker is for; if
 * absent or unrecognized, the first account on the session is used.
 * Cross-account browsing was deliberately scoped out for v1 — picker
 * shows what *this* account owns, nothing else.
 */
CatalogApp.get('/', async c => {
    const principal = c.get('principal');
    if (principal.kind === 'anonymous')
        throw new UnauthenticatedError();

    const headerAccount = c.req.header(ACTIVE_ACCOUNT_HEADER) || null;
    const accountId =
        headerAccount && principal.accounts.some(a => a.id === headerAccount)
            ? headerAccount
            : principal.accounts[0]?.id;
    if (!accountId) throw new UnauthorizedError();

    const entities = await ListOwnedEntities(c.env.DJIBB_AUTH, accountId);
    return c.json({ account_id: accountId, entities });
});
