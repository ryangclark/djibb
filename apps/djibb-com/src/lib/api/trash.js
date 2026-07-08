// @ts-check
import { api } from './client.js';

/**
 * One row in the per-account Trash. Mirrors `TrashedEntity` on the
 * server (workers/src/catalog/service.ts). Times are unix seconds.
 *
 * @typedef {object} TrashedEntity
 * @property {string} id
 * @property {'list'|'template'|'workspace'} type
 * @property {string|null} name
 * @property {string} slug
 * @property {number} time_deleted
 * @property {number} time_updated
 * @property {string|null} cascade_source
 */

/**
 * ADR 0011 §Step 10b-ui: fetch soft-deleted entities the actor owns
 * for one account. URL convention mirrors `/a/<suffix>/workspaces`
 * (`accountId` is the full prefixed id, e.g. `a/0Hb…`; the suffix is
 * what goes in the URL).
 *
 * @param {string} accountId
 * @returns {Promise<TrashedEntity[]>}
 */
export async function fetchTrashForAccount(accountId) {
	return /** @type {TrashedEntity[]} */ (await api.get(`/${accountId}/trash`));
}
