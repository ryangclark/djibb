import { dev } from '$app/environment';

const ACTIVE_ACCOUNT_HEADER = 'X-Djibb-Active-Account';

/**
 * Fetch owner-only entities (lists + templates) for the active account.
 * Mirrors the worker's `GET /entities` endpoint shape.
 *
 * @param {object} input
 * @param {string | null} input.accountId Active account; passed via the
 *   `X-Djibb-Active-Account` header so the worker can pin its choice.
 *   When null, the worker falls back to the first session account.
 * @returns {Promise<{ id: string, type: 'list' | 'template', name: string | null }[]>}
 */
export async function fetchOwnedEntities({ accountId }) {
	const protocol = `http${dev ? '' : 's'}:`;
	const url = `${protocol}//${import.meta.env.VITE_REPLICACHE_BASE_URL}/entities`;

	/** @type {Record<string, string>} */
	const headers = {};
	if (accountId) headers[ACTIVE_ACCOUNT_HEADER] = accountId;

	const response = await fetch(url, {
		method: 'GET',
		credentials: 'include',
		headers
	});
	if (!response.ok) {
		throw new Error(
			`fetchOwnedEntities failed: ${response.status} ${await response.text()}`
		);
	}
	const body = await response.json();
	return body.entities ?? [];
}
