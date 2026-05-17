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
 * Request a magic-link email.
 *
 * The server returns 200 unconditionally on a well-formed request
 * (it does NOT confirm whether the email is known — that would leak
 * Account existence). We treat any 2xx as "we tried" and surface a
 * generic "check your inbox" message regardless. 4xx/5xx surface as
 * a generic failure so the user can retry.
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

    if (!res.ok) {
        throw new Error(`Sign-in request failed (${res.status})`);
    }
}
