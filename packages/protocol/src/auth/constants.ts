import { z } from 'zod';

/**
 * OAuth provider vocabulary — the pure, protocol-facing slice of the
 * former `workers/src/auth/constants.ts`. The session/cookie/redirect
 * config and the auth Durable Object name stay backend-side; only the
 * provider enum (which types the Account schema) and its display map
 * are part of the contract.
 */
export const OAUTH_PROVIDER = z.enum(['djibb', 'google']);

export type OAuthProvider = z.infer<typeof OAUTH_PROVIDER>;

/**
 * Display name per provider. Typed as a total `Record` over the enum so
 * adding a member to `OAUTH_PROVIDER` is a compile error here until the
 * pretty name is supplied — the type enforces what a comment used to ask.
 */
export const OAUTH_PROVIDER_PRETTY: Record<OAuthProvider, string> = {
    djibb: 'djibb',
    google: 'Google',
};
