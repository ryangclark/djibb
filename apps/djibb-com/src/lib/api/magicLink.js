// @ts-check
/**
 * Magic-link auth API client (ADR 0010).
 *
 * Only /request is called from the page UI. /land and /consume are
 * server-rendered surfaces — the email link lands on the worker's
 * interstitial, which posts back to /consume directly. The frontend
 * never holds a raw token.
 */

import { api, DjibbHttpError } from './client.js';

/**
 * @typedef {'cooldown'|'email_15min'|'email_24h'|'ip_hour'} RateLimitReason
 */

/**
 * Thrown when /auth/magic/request returns 429. Carries the server's
 * Retry-After value so the form can display an accurate countdown.
 *
 * Other Error types from `requestMagicLink` indicate generic failure
 * (network, 5xx, etc.) and should surface as a retryable error to
 * the user.
 */
export class MagicLinkRateLimitError extends Error {
    /**
     * @param {number} retryAfterSeconds
     * @param {RateLimitReason | null} reason
     */
    constructor(retryAfterSeconds, reason) {
        super(`Rate limited (retry in ${retryAfterSeconds}s)`);
        this.name = 'MagicLinkRateLimitError';
        this.retryAfterSeconds = retryAfterSeconds;
        this.reason = reason;
    }
}

/**
 * Request a magic-link email.
 *
 * Response handling:
 *   - 2xx → success. Surface a generic "check your inbox" message
 *     regardless of whether the address is known; the server returns
 *     200 unconditionally on a well-formed unknown email, and we
 *     mirror that here so the client never accidentally leaks
 *     Account existence.
 *   - 429 → MagicLinkRateLimitError with the server's retry-after
 *     window. The form maps this to a precise countdown and reason
 *     message.
 *   - 4xx/5xx → generic Error.
 *
 * @param {{ email: string, next?: string }} params
 * @returns {Promise<void>}
 */
export async function requestMagicLink({ email, next }) {
    try {
        await api.post('/auth/magic/request', {
            json: { email, next: next ?? '/workspaces' }
        });
    } catch (err) {
        if (err instanceof DjibbHttpError) {
            if (err.status === 429) throw rateLimitFrom(err);
            throw new Error(`Sign-in request failed (${err.status})`);
        }
        throw err; // network / other — surface as a retryable error.
    }
}

/**
 * Turn a 429 into a `MagicLinkRateLimitError`, reading the retry window from
 * the JSON body (`retry_after_seconds` + `reason`) and falling back to the
 * `Retry-After` header only when the body can't be parsed.
 *
 * @param {DjibbHttpError} err
 * @returns {MagicLinkRateLimitError}
 */
function rateLimitFrom(err) {
    let retryAfter = 60;
    /** @type {RateLimitReason | null} */
    let reason = null;
    try {
        const body = JSON.parse(err.bodyText);
        if (body && typeof body === 'object') {
            if (typeof body.retry_after_seconds === 'number') {
                retryAfter = body.retry_after_seconds;
            }
            if (typeof body.reason === 'string') reason = body.reason;
        }
    } catch {
        const hdr = err.headers.get('Retry-After');
        const parsed = hdr ? parseInt(hdr, 10) : NaN;
        if (Number.isFinite(parsed)) retryAfter = parsed;
    }
    return new MagicLinkRateLimitError(retryAfter, reason);
}
