// @ts-check
/**
 * Magic-link auth API client (ADR 0010).
 *
 * Only /request is called from the page UI. /land and /consume are
 * server-rendered surfaces — the email link lands on the worker's
 * interstitial, which posts back to /consume directly. The frontend
 * never holds a raw token.
 */

const BASE = import.meta.env.VITE_API_BASE_URL;

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
    const res = await fetch(`${BASE}/auth/magic/request`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email,
            next: next ?? '/workspaces'
        })
    });

    if (res.ok) return;

    if (res.status === 429) {
        let retryAfter = 60;
        /** @type {RateLimitReason | null} */
        let reason = null;
        try {
            const body = await res.json();
            if (
                body &&
                typeof body === 'object' &&
                typeof body.retry_after_seconds === 'number'
            ) {
                retryAfter = body.retry_after_seconds;
            }
            if (
                body &&
                typeof body === 'object' &&
                typeof body.reason === 'string'
            ) {
                reason = body.reason;
            }
        } catch {
            // Fall back to Retry-After header if body parse failed.
            const hdr = res.headers.get('Retry-After');
            const parsed = hdr ? parseInt(hdr, 10) : NaN;
            if (Number.isFinite(parsed)) retryAfter = parsed;
        }
        throw new MagicLinkRateLimitError(retryAfter, reason);
    }

    throw new Error(`Sign-in request failed (${res.status})`);
}
