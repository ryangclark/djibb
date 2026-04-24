import { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { HonoEnv } from '..';
import { BaseSessionCookieAttributes, CookieNames } from './constants';
import { ValidateSession } from './session';

/**
 * Session middleware.
 */
export async function HandleSession(c: Context<HonoEnv>, next: Next) {
    // If `sessionId` is `''`, then we have a blank session cookie.
    const sessionId = getCookie(c, CookieNames.Session) ?? null;

    if (!sessionId) {
        c.set('user', null);
        c.set('session', null);
        await next();
        return;
    }

    const session = await ValidateSession(c.env.DJIBB_AUTH, sessionId);
    if (session && session.fresh) {
        setCookie(
            c,
            CookieNames.Session,
            session.id,
            BaseSessionCookieAttributes
        );
    }

    if (!session) {
        // Set a blank cookie.
        setCookie(c, CookieNames.Session, '', BaseSessionCookieAttributes);
    }

    // c.set('user', user);
    c.set('session', session);

    await next();
}
