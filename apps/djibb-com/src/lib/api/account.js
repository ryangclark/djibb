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
