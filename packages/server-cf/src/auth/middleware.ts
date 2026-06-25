import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import type { HonoEnv } from '..';
import type { Account } from '@djibb/protocol/account';
import type { Session } from './session';
import { BaseSessionCookieAttributes, CookieNames } from './constants';
import { ValidateSession } from './session';
import { VerifyBearerCredential } from './credential';

/**
 * The single request→Account seam (ADR 0022 §2). It admits two kinds of
 * credential and resolves both to the same `session` shape downstream:
 *
 *   1. The interactive **session cookie** (`djibb-session`) — multi-account,
 *      minted by OAuth/magic-link, validated/refreshed against `sessions`.
 *   2. A non-interactive **bearer token** (`Authorization: Bearer …`) —
 *      single-Account, from the `issued_credentials` substrate (CLI,
 *      email-reply, bots). It resolves to a synthesized single-account
 *      session so every downstream consumer (which reads
 *      `session.accounts`) works unchanged, and additionally to the
 *      `credential` context var carrying `bound_entity_id` forward.
 *
 * `resolveRole` (`auth/resolver.ts`) is deliberately untouched: a bearer
 * request acts at its Account's resolved role exactly as a cookie session
 * does (ADR 0021's single `(Account, entity) → role` model).
 *
 * The cookie takes precedence: a request carrying both a valid cookie and
 * a bearer header authenticates as the cookie session (browsers don't
 * send `Authorization`, so this only matters to deliberately-mixed
 * clients, and the interactive session is the safer default there).
 */
export async function HandleSession(c: Context<HonoEnv>, next: Next) {
    c.set('credential', null);

    // If `sessionId` is `''`, then we have a blank session cookie.
    const sessionId = getCookie(c, CookieNames.Session) ?? null;

    if (sessionId) {
        const session = await ValidateSession(c.env.DJIBB_AUTH, sessionId);
        if (session && session.fresh) {
            setCookie(
                c,
                CookieNames.Session,
                session.id,
                BaseSessionCookieAttributes,
            );
        }

        if (!session) {
            // Set a blank cookie.
            setCookie(c, CookieNames.Session, '', BaseSessionCookieAttributes);
        }

        c.set('session', session);
        await next();
        return;
    }

    // No session cookie — try a bearer credential (non-interactive
    // clients per ADR 0022). Falls through to anonymous on any failure
    // (malformed/unknown/forged/revoked/expired all return null).
    const bearer = readBearerToken(c);
    if (bearer) {
        const resolved = await VerifyBearerCredential(
            c.env.DJIBB_AUTH,
            bearer,
            { waitUntil: promise => c.executionCtx.waitUntil(promise) },
        );

        if (resolved) {
            c.set('session', synthesizeSession(resolved.account));
            c.set('credential', resolved);
            await next();
            return;
        }
    }

    // Anonymous.
    c.set('user', null);
    c.set('session', null);
    await next();
}

/** Extracts the raw token from an `Authorization: Bearer <token>` header. */
function readBearerToken(c: Context<HonoEnv>): string | null {
    const header = c.req.header('Authorization');
    if (!header) return null;

    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1]!.trim() : null;
}

/**
 * Wraps a bearer-resolved Account in the `session` shape downstream
 * consumers expect (they read `session.accounts`). It is NOT a real
 * session row — `id` is left blank (a bearer request owns no `s/` session
 * id; the acting credential is on the `credential` context var instead),
 * and `time_expires` is a far-future sentinel (the credential's own
 * expiry is enforced in `VerifyBearerCredential`, not re-checked here).
 * Credentials never enter the `sessions` substrate (ADR 0022 §4); this is
 * a per-request adapter only.
 */
function synthesizeSession(account: Account): Session {
    return {
        accounts: [account],
        fresh: false,
        id: '',
        time_created: account.time_created,
        // Max representable Date — bearer requests aren't cookie-refreshed.
        time_expires: new Date(8640000000000000),
    };
}
