/**
 * In-house Google OIDC client tests (GH #52 — arctic replacement).
 *
 * The three things arctic did for the Google flow, now ours:
 *   1. `generateGoogleState` / `generateGoogleCodeVerifier` produce
 *      high-entropy, PKCE-legal (RFC 7636 §4.1 unreserved) strings.
 *   2. `createGoogleAuthorizationURL` builds the right endpoint + params,
 *      and its `code_challenge` is a genuine `S256` of the verifier — proven
 *      by round-tripping through the *verifier* side (`pkceS256Matches`),
 *      so the generate and verify halves can never silently diverge.
 *   3. `exchangeGoogleAuthorizationCode` sends the `authorization_code`
 *      grant Google expects (form body, HTTP Basic client auth) and returns
 *      the access token; a non-2xx throws (→ the caller's typed error).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createGoogleAuthorizationURL,
    exchangeGoogleAuthorizationCode,
    generateGoogleCodeVerifier,
    generateGoogleState,
} from '../src/auth/google';
import { pkceS256Matches } from '../src/auth/connect';

const PKCE_UNRESERVED = /^[A-Za-z0-9\-._~]+$/;

describe('Google OAuth randoms', () => {
    it('state and verifier are PKCE-legal and long enough', () => {
        for (const value of [generateGoogleState(), generateGoogleCodeVerifier()]) {
            expect(value.length).toBeGreaterThanOrEqual(43);
            expect(value.length).toBeLessThanOrEqual(128);
            expect(value).toMatch(PKCE_UNRESERVED);
        }
    });

    it('does not repeat across calls', () => {
        const seen = new Set(
            Array.from({ length: 32 }, () => generateGoogleCodeVerifier()),
        );
        expect(seen.size).toBe(32);
    });
});

describe('createGoogleAuthorizationURL', () => {
    it('targets Google with the expected OAuth params', async () => {
        const url = await createGoogleAuthorizationURL({
            clientId: 'client-abc',
            redirectUri: 'https://api.djibb.com/auth/google/verify',
            state: 'the-state',
            codeVerifier: 'the-verifier',
            scopes: ['profile', 'email'],
        });

        expect(url.origin + url.pathname).toBe(
            'https://accounts.google.com/o/oauth2/v2/auth',
        );
        const p = url.searchParams;
        expect(p.get('response_type')).toBe('code');
        expect(p.get('client_id')).toBe('client-abc');
        expect(p.get('redirect_uri')).toBe(
            'https://api.djibb.com/auth/google/verify',
        );
        expect(p.get('state')).toBe('the-state');
        expect(p.get('scope')).toBe('profile email');
        expect(p.get('code_challenge_method')).toBe('S256');
        expect(p.get('code_challenge')).toBeTruthy();
    });

    it('challenge is a real S256 of the verifier (verify side agrees)', async () => {
        const codeVerifier = generateGoogleCodeVerifier();
        const url = await createGoogleAuthorizationURL({
            clientId: 'c',
            redirectUri: 'https://api.djibb.com/cb',
            state: 's',
            codeVerifier,
            scopes: ['profile'],
        });
        const challenge = url.searchParams.get('code_challenge')!;

        // The exchange-side check must accept this challenge for the same
        // verifier — and reject a different verifier.
        await expect(pkceS256Matches(codeVerifier, challenge)).resolves.toBe(
            true,
        );
        await expect(
            pkceS256Matches(generateGoogleCodeVerifier(), challenge),
        ).resolves.toBe(false);
    });

    it('omits scope when none are given', async () => {
        const url = await createGoogleAuthorizationURL({
            clientId: 'c',
            redirectUri: 'https://api.djibb.com/cb',
            state: 's',
            codeVerifier: 'v',
            scopes: [],
        });
        expect(url.searchParams.has('scope')).toBe(false);
    });
});

describe('exchangeGoogleAuthorizationCode', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('POSTs the authorization_code grant with Basic client auth', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                new Response(
                    JSON.stringify({
                        access_token: 'ya29.token',
                        token_type: 'Bearer',
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            );

        const result = await exchangeGoogleAuthorizationCode({
            clientId: 'client-abc',
            clientSecret: 'secret-xyz',
            redirectUri: 'https://api.djibb.com/cb',
            code: 'auth-code',
            codeVerifier: 'the-verifier',
        });

        expect(result).toEqual({ accessToken: 'ya29.token' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(endpoint).toBe('https://oauth2.googleapis.com/token');
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe(
            'application/x-www-form-urlencoded',
        );
        expect(headers.Authorization).toBe(
            `Basic ${btoa('client-abc:secret-xyz')}`,
        );

        const body = new URLSearchParams(init.body as string);
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('auth-code');
        expect(body.get('redirect_uri')).toBe('https://api.djibb.com/cb');
        expect(body.get('code_verifier')).toBe('the-verifier');
    });

    it('throws on a non-2xx token response', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ error: 'invalid_grant' }), {
                status: 400,
            }),
        );

        await expect(
            exchangeGoogleAuthorizationCode({
                clientId: 'c',
                clientSecret: 's',
                redirectUri: 'https://api.djibb.com/cb',
                code: 'bad',
                codeVerifier: 'v',
            }),
        ).rejects.toThrow();
    });

    it('throws when access_token is missing', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ token_type: 'Bearer' }), {
                status: 200,
            }),
        );

        await expect(
            exchangeGoogleAuthorizationCode({
                clientId: 'c',
                clientSecret: 's',
                redirectUri: 'https://api.djibb.com/cb',
                code: 'ok',
                codeVerifier: 'v',
            }),
        ).rejects.toThrow();
    });
});
