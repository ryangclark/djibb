import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import type { HonoEnv } from '..';
import { BaseSessionCookieAttributes, CookieNames } from './constants';
import { resolvePrincipal } from './principal';

/**
 * The single request→Account seam (ADR 0022 §2) as a thin adapter over
 * {@link resolvePrincipal}. It reads the session cookie and the
 * `Authorization` header off the request, resolves them to one
 * {@link RequestPrincipal}, applies the returned cookie directive, and
 * sets the `principal` context var. All precedence logic — cookie beats
 * bearer, an invalid cookie short-circuits rather than upgrading to the
 * bearer — lives in `resolvePrincipal` (and is unit-tested there); this
 * function is deliberately too thin to hide a bug.
 *
 * `resolveRole` (`auth/resolver.ts`) is untouched: every arm acts at its
 * Account's resolved role exactly as a cookie session always did (ADR
 * 0021's single `(Account, entity) → role` model).
 */
export async function HandleSession(c: Context<HonoEnv>, next: Next) {
    const { principal, cookie } = await resolvePrincipal(c.env.DJIBB_AUTH, {
        // A blank ("") cookie is treated as absent inside resolvePrincipal.
        sessionId: getCookie(c, CookieNames.Session) ?? null,
        bearerToken: readBearerToken(c),
        waitUntil: promise => c.executionCtx.waitUntil(promise),
    });

    if (cookie === 'refresh' && principal.kind === 'session') {
        setCookie(
            c,
            CookieNames.Session,
            principal.sessionId,
            BaseSessionCookieAttributes,
        );
    } else if (cookie === 'clear') {
        setCookie(c, CookieNames.Session, '', BaseSessionCookieAttributes);
    }

    c.set('principal', principal);
    await next();
}

/** Extracts the raw token from an `Authorization: Bearer <token>` header. */
function readBearerToken(c: Context<HonoEnv>): string | null {
    const header = c.req.header('Authorization');
    if (!header) return null;

    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1]!.trim() : null;
}
