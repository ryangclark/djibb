const BASE = import.meta.env.VITE_API_BASE_URL;

/**
 * One entity shared with the actor. Mirrors `SharedEntity` on the server
 * (workers/src/catalog/service.ts). `time_updated` is unix seconds.
 *
 * @typedef {object} SharedEntity
 * @property {string} id
 * @property {'list'|'template'} type
 * @property {string|null} name
 * @property {string} slug
 * @property {string} role
 * @property {number} time_updated
 */

/**
 * ADR 0009 §"Shared with me": fetch lists/templates shared directly with
 * one account (granted, not owned, not covered by a workspace
 * membership). URL convention mirrors `/a/<suffix>/workspaces`.
 *
 * @param {string} accountId
 * @returns {Promise<SharedEntity[]>}
 */
export async function fetchSharedForAccount(accountId) {
	const res = await fetch(`${BASE}/${accountId}/shared`, {
		credentials: 'include'
	});
	if (!res.ok) throw new Error(`shared fetch failed: ${res.status}`);
	return res.json();
}
