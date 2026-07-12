/**
 * sessionCookieAttributes — the session cookie's attributes, which are
 * env-dependent because `Secure` must be off on localhost (wrangler dev
 * serves plain http) and on everywhere else (GH #38).
 *
 * Pure (context in, CookieOptions out) — no Workers runtime needed.
 */
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';

import { sessionCookieAttributes } from '../src/auth/constants';
import type { HonoEnv } from '../src';

/** Only `env.ENV` is read, so that's all the context needs to carry. */
function ctx(env: string | undefined): Context<HonoEnv> {
    return { env: { ENV: env } } as unknown as Context<HonoEnv>;
}

describe('sessionCookieAttributes', () => {
    it('sets Secure outside dev, so the 30-day session cookie never rides plaintext', () => {
        expect(sessionCookieAttributes(ctx('production')).secure).toBe(true);
        expect(sessionCookieAttributes(ctx('staging')).secure).toBe(true);
    });

    it('sets Secure when ENV is unset, so a missing var fails safe', () => {
        // `ENV` is declared in wrangler.toml `[vars]`, but a deploy that
        // dropped it (or any environment that forgets to set it) must not
        // silently downgrade the cookie. Anything that isn't the literal
        // 'dev' gets `Secure`; only dev opts out.
        expect(sessionCookieAttributes(ctx(undefined)).secure).toBe(true);
    });

    it('omits Secure in dev, so localhost over http can still sign in', () => {
        expect(sessionCookieAttributes(ctx('dev')).secure).toBe(false);
    });

    it('keeps the other hardening attributes', () => {
        const attrs = sessionCookieAttributes(ctx('production'));

        expect(attrs.httpOnly).toBe(true);
        expect(attrs.sameSite).toBe('lax');
    });
});
