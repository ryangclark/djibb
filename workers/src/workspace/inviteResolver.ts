import { Hono } from 'hono';

import type { HonoEnv } from '..';

import { HandleSession } from '../auth/middleware';
import { NotFoundError, UnauthenticatedError } from '../errors';
import { ResolveInvitedWorkspaceBySlug } from './service';

/**
 * ADR 0011 §Step 10d.3: slug→id resolver for the pre-membership
 * workspace-invite accept surface. Mounted at `/workspace-invite`.
 *
 * A not-yet-member invitee following `/w/<slug>?from_invite=1` has the
 * slug but not the entity id (the slug-keyed `/w/[slug]` route can't
 * mount Replicache by id otherwise, and the id isn't on the session's
 * workspace list because the account isn't a member yet). This endpoint
 * returns `{ id, name }` — but only when the active account actually
 * holds a pending invite to the workspace (see
 * `ResolveInvitedWorkspaceBySlug` for why a bare lookup would be an
 * unacceptable discovery oracle).
 */
export const WorkspaceInviteApp = new Hono<HonoEnv>();

WorkspaceInviteApp.use('*', HandleSession);

WorkspaceInviteApp.get('/:slug', async c => {
    const session = c.get('session');
    if (!session) throw new UnauthenticatedError();

    // Match against every verified email on the session, not just the
    // active account's: the invite may be addressed to a different
    // account the user holds, and the banner lets them switch before
    // accepting. `acceptInvitation` does the authoritative per-account
    // identity match at accept time.
    const identityValues = session.accounts.flatMap(a =>
        a.email_verified && a.email ? [a.email.trim().toLowerCase()] : []
    );

    const resolved = await ResolveInvitedWorkspaceBySlug(c.env.DJIBB_AUTH, {
        slug: c.req.param('slug'),
        identityValues,
        nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!resolved) throw new NotFoundError();
    return c.json(resolved);
});
