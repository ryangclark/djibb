import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';

import { initializeLucia } from './lucia';

/**
 * Session middleware.
 *
 * This inits Lucia instance for the request, checking the cookie
 * against the DB and pulling any associated session and user data,
 * which it then attaches to the Hono Context for easy access by
 * functions as needed.
 *
 * @see: https://lucia-auth.com/guides/validate-session-cookies/hono
 */
export async function handle_session(c: Context, next: Next) {
    // Init Lucia instance using the request's d1 binding.
    const lucia = initializeLucia(c.env.DJIBB_AUTH);

    // Set `lucia` on the Hono instance so we can access it
    // anywhere we use Hono via `c.get('lucia')`.
    c.set('lucia', lucia);

    const sessionId = getCookie(c, lucia.sessionCookieName) ?? null;
    if (!sessionId) {
        c.set('user', null);
        c.set('session', null);
        return next();
    }

    const { session, user } = await lucia.validateSession(sessionId);
    if (session && session.fresh) {
        // use `header()` instead of `setCookie()` to avoid TS errors
        c.header(
            'Set-Cookie',
            lucia.createSessionCookie(session.id).serialize(),
            {
                append: true,
            }
        );
    }

    if (!session) {
        c.header('Set-Cookie', lucia.createBlankSessionCookie().serialize(), {
            append: true,
        });
    }

    c.set('user', user);
    c.set('session', session);

    await next();
}
