// @ts-check
import { api } from './api/client.js';

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
	const body = /** @type {{ entities?: { id: string, type: 'list' | 'template', name: string | null }[] }} */ (
		await api.get('/entities', { activeAccount: accountId })
	);
	return body.entities ?? [];
}
