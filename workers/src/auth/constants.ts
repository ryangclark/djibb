import { Context } from 'hono';
import { CookieOptions } from 'hono/utils/cookie';
import { TimeSpan } from 'lucia';
import { z } from 'zod';
import { HonoEnv } from '..';

export const SESSION_EXPIRATION = new TimeSpan(30, 'd');

export const BaseSessionCookieAttributes: CookieOptions = {
    httpOnly: true,
    maxAge: SESSION_EXPIRATION.seconds(),
    // path: '/',
    sameSite: 'lax',
    // secure: true, // TODO: check whether this should be changed for Prod
};

export const CookieNames = {
    GoogleState: 'google_oauth_state',
    GoogleCodeVerifier: 'google_oauth_code_verifier',
    RefererOrigin: 'referer_origin',
    Session: 'djibb-session',
};

export const DURABLE_OBJECT_NAME_AUTH = '_djibb_auth';

// Please ensure these match `OAUTH_PROVIDER` enum!
export const OAUTH_PROVIDER_PRETTY = {
    djibb: 'djibb',
    google: 'Google',
};
export const OAUTH_PROVIDER = z.enum(['djibb', 'google']);
export const OAUTH_REDIRECT_URI = {
    /** Returns the base API URL for auth,
     * pulling the URL from an environment variable. */
    base(c: Context<HonoEnv>) {
        return `${c.env.API_ORIGIN}/auth`;
    },
    google: '/google/verify',
};
