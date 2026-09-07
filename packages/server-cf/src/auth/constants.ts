import type { Context } from 'hono';
import type { CookieOptions } from 'hono/utils/cookie';
import { TimeSpan } from 'lucia';
import type { HonoEnv } from '..';

// `OAUTH_PROVIDER` / `OAUTH_PROVIDER_PRETTY` moved to @djibb/protocol/auth/constants
// (ADR 0014) — they're pure contract; the rest below is backend-only.

export const SESSION_EXPIRATION = new TimeSpan(30, 'd');

export function sessionCookieAttributes(
    c: Context<HonoEnv>
): CookieOptions {
    return {
        httpOnly: true,
        maxAge: SESSION_EXPIRATION.seconds(),
        // path: '/',
        sameSite: 'lax',
        secure: c.env.ENV !== 'dev', // set to false in localhost
    };
}

export const CookieNames = {
    GoogleState: 'google_oauth_state',
    GoogleCodeVerifier: 'google_oauth_code_verifier',
    PendingInvite: 'djibb_pending_invite',
    RefererOrigin: 'referer_origin',
    Session: 'djibb-session',
    /**
     * Carries the connect-ceremony context (client origin, PKCE challenge,
     * label) across an OAuth round-trip (ADR 0024 §1). OAuth completes in
     * the browser that started it, so a short-lived httpOnly cookie is the
     * right vessel — exactly like {@link CookieNames.GoogleState}. The
     * magic-link path can span two devices, so it carries the same context
     * on the token row instead (migration 0016 `connect_*` columns).
     */
    Connect: 'djibb_connect',
};

export const DURABLE_OBJECT_NAME_AUTH = '_djibb_auth';

export const OAUTH_REDIRECT_URI = {
    /** Returns the base API URL for auth,
     * pulling the URL from an environment variable. */
    base(c: Context<HonoEnv>) {
        return `${c.env.API_ORIGIN}/auth`;
    },
    google: '/google/verify',
};
