/**
 * Minimal Google OAuth 2.0 / OIDC client (GH #52).
 *
 * Replaces the deprecated `arctic` package (pilcrowonpaper's auth stack is
 * EOL). arctic gave us exactly three things for the Google sign-in flow —
 * an opaque `state`, a PKCE `code_verifier`, an authorization-URL builder,
 * and the code-for-tokens exchange — all small, standard OAuth. This module
 * reimplements that surface faithfully: same endpoints, same request shape
 * (form-encoded token POST with HTTP Basic client auth, `S256` PKCE) that
 * arctic sent, so Google sees an identical request and sign-in behavior is
 * unchanged. Nothing else about the flow moves (ADR 0010 account resolution,
 * ADR 0024 connect ceremony both sit above this).
 */

import { randomString } from '@djibb/protocol/id';
import { base64UrlSha256 } from '../utils/base64url';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Length of the opaque `state` / PKCE `code_verifier`. `randomString` draws
 * from a 64-char URL-safe alphabet (`A-Za-z0-9-_`) — every char is in the
 * PKCE unreserved set (RFC 7636 §4.1), so a 43-char string is a valid
 * verifier at the spec's minimum length (~256 bits of entropy).
 */
const OAUTH_RANDOM_LENGTH = 43;

/** Opaque anti-forgery `state` value, round-tripped through Google. */
export function generateGoogleState(): string {
    return randomString(OAUTH_RANDOM_LENGTH);
}

/** PKCE `code_verifier` (RFC 7636): high-entropy, held only by us. */
export function generateGoogleCodeVerifier(): string {
    return randomString(OAUTH_RANDOM_LENGTH);
}

/**
 * Build the Google authorization URL with PKCE `S256`. Mirrors arctic's
 * `Google.createAuthorizationURL(state, codeVerifier, scopes)`: `openid` is
 * implied by Google for these scopes, `scope` is space-joined, and the
 * challenge is `BASE64URL(SHA256(codeVerifier))`.
 */
export async function createGoogleAuthorizationURL(args: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeVerifier: string;
    scopes: readonly string[];
}): Promise<URL> {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', args.clientId);
    url.searchParams.set('redirect_uri', args.redirectUri);
    url.searchParams.set('state', args.state);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set(
        'code_challenge',
        await base64UrlSha256(args.codeVerifier),
    );
    if (args.scopes.length > 0) {
        url.searchParams.set('scope', args.scopes.join(' '));
    }
    return url;
}

/** The one token-response field we consume: the userinfo bearer. */
export type GoogleTokenResponse = {
    accessToken: string;
};

/**
 * Exchange an authorization code + PKCE verifier for Google tokens (the
 * `authorization_code` grant). Faithful to arctic's confidential-client
 * request: form-encoded body, client authenticated via HTTP Basic
 * (`Authorization: Basic base64(clientId:clientSecret)`), `Accept: json`.
 *
 * Throws on any non-2xx / malformed response so the caller's typed error
 * channel (`effect/oauth.ts` → `OAuthExchangeError`) maps it to a single
 * HTTP-boundary failure, exactly as before.
 */
export async function exchangeGoogleAuthorizationCode(args: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
}): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', args.code);
    body.set('redirect_uri', args.redirectUri);
    body.set('code_verifier', args.codeVerifier);

    const basic = btoa(`${args.clientId}:${args.clientSecret}`);
    const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Authorization: `Basic ${basic}`,
        },
        body: body.toString(),
    });

    if (!response.ok) {
        throw new Error(
            `Google token endpoint responded ${response.status} ${response.statusText}`,
        );
    }

    const data = (await response.json()) as unknown;
    if (
        typeof data !== 'object' ||
        data === null ||
        typeof (data as { access_token?: unknown }).access_token !== 'string'
    ) {
        throw new Error("Google token response missing 'access_token'");
    }

    return { accessToken: (data as { access_token: string }).access_token };
}
