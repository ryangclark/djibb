import { z } from 'zod';

/**
 * OAuth provider vocabulary — the pure, protocol-facing slice of the
 * former `workers/src/auth/constants.ts`. The session/cookie/redirect
 * config and the auth Durable Object name stay backend-side; only the
 * provider enum (which types the Account schema) and its display map
 * are part of the contract.
 */
export const OAUTH_PROVIDER = z.enum(['djibb', 'google']);

// Please ensure these match `OAUTH_PROVIDER` enum!
export const OAUTH_PROVIDER_PRETTY = {
    djibb: 'djibb',
    google: 'Google',
};
