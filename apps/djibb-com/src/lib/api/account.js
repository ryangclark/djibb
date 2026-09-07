// @ts-check
import { api, DjibbHttpError } from './client.js';

/**
 * @param {string} accountId Full prefixed ID, e.g. "a/0Hb...".
 * @param {string} userName
 * @returns {Promise<{ id: string, user_name: string, detail: string }>}
 */
export async function setAccountUsername(accountId, userName) {
	try {
		return /** @type {{ id: string, user_name: string, detail: string }} */ (
			await api.patch(`/${accountId}`, {
				activeAccount: accountId,
				json: { user_name: userName }
			})
		);
	} catch (err) {
		// The server sends a human-readable reason as the response body
		// (e.g. "Username already taken") and AccountRow renders `err.message`
		// directly — surface the body, not the transport's generic message.
		if (err instanceof DjibbHttpError) throw new Error(err.bodyText);
		throw err;
	}
}

/**
 * @param {string} username
 * @returns {Promise<{ id: string, display_name: string, image: string|null }|null>}
 */
export async function lookupUsername(username) {
	return /** @type {{ id: string, display_name: string, image: string|null }|null} */ (
		await api.get(`/u/${encodeURIComponent(username)}`, { notFoundAsNull: true })
	);
}

/**
 * Thrown when `deleteAccount` is refused because the session hasn't completed a
 * fresh sudo step-up for *this* account (server: `403 { error: 'sudo_required' }`,
 * GH #58). It is not a failure so much as "you skipped a step" — the page maps
 * it back to the re-auth prompt rather than to an error banner. A stale sudo
 * (window elapsed) surfaces the same way, which is correct: the user must
 * re-confirm before we'll delete.
 */
export class SudoRequiredError extends Error {
	constructor() {
		super('A fresh re-authentication is required to delete this account.');
		this.name = 'SudoRequiredError';
	}
}

/**
 * Start a sudo-mode step-up for `accountId` (GH #58). Mints + emails a
 * `purpose='sudo'` magic link; consuming it (same device, on the worker's
 * interstitial) stamps this session sudo-fresh and lands back on
 * `/accounts?sudo=ok`. Nothing is deleted here — this only unlocks the
 * confirm step.
 *
 * Soft-succeeds like `requestMagicLink`: any 2xx is "check your email". In the
 * `_dev` seam the server returns the landing URL so a local walk-through can
 * skip the inbox; we pass it back for the page to surface.
 *
 * @param {string} accountId Full prefixed ID, e.g. "a/0Hb...".
 * @returns {Promise<{ landingUrl: string|null }>}
 */
export async function requestSudo(accountId) {
	try {
		const body = /** @type {{ landing_url?: string } | undefined} */ (
			await api.post('/auth/sudo/request', {
				activeAccount: accountId,
				json: { account_id: accountId }
			})
		);
		return { landingUrl: body?.landing_url ?? null };
	} catch (err) {
		// A 200 with an empty body (production) parses to a throw in the
		// transport's `parse:'json'` default — treat "ok but no JSON" as success.
		if (err instanceof DjibbHttpError) {
			throw new Error(`Re-authentication request failed (${err.status}).`);
		}
		if (err instanceof SyntaxError) return { landingUrl: null };
		throw err;
	}
}

/**
 * Permanently delete (Phase 1: soft-delete + immediate global revoke) the
 * identity `accountId` (GH #58). Requires a fresh sudo step-up for this same
 * account; without it the server answers `403 { error: 'sudo_required' }`,
 * which we raise as {@link SudoRequiredError} so the page can re-prompt.
 *
 * On success the server either clears the session cookie (the caller's session
 * held only this account → `signedOut: true`) or returns the surviving
 * accounts (a multi-account session drops this one in place → `signedOut:
 * false`).
 *
 * @param {string} accountId Full prefixed ID, e.g. "a/0Hb...".
 * @returns {Promise<{ signedOut: boolean, accounts: import('@djibb/protocol/account').Account[] }>}
 */
export async function deleteAccount(accountId) {
	try {
		const body = /** @type {{ accounts?: import('@djibb/protocol/account').Account[] } | undefined} */ (
			await api.post('/auth/account/delete', {
				activeAccount: accountId,
				json: { account_id: accountId }
			})
		);
		// 204 → transport returns undefined: the single-account session's cookie
		// was cleared. 200 → `{ accounts }`: a multi-account session survives.
		if (body && Array.isArray(body.accounts)) {
			return { signedOut: false, accounts: body.accounts };
		}
		return { signedOut: true, accounts: [] };
	} catch (err) {
		if (err instanceof DjibbHttpError) {
			if (err.status === 403 && isSudoRequired(err.bodyText)) {
				throw new SudoRequiredError();
			}
			throw new Error(`Account deletion failed (${err.status}).`);
		}
		throw err;
	}
}

/**
 * @param {string} bodyText
 * @returns {boolean}
 */
function isSudoRequired(bodyText) {
	try {
		const body = JSON.parse(bodyText);
		return body?.error === 'sudo_required';
	} catch {
		return false;
	}
}
