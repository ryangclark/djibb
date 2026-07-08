// @ts-check
import { api } from './client.js';

/**
 * One pending invitation in the `/invitations` inbox. Mirrors
 * `PendingInvitation` on the server (workers/src/catalog/service.ts).
 * Times are unix seconds.
 *
 * @typedef {object} PendingInvitation
 * @property {string} id
 * @property {string} target_id
 * @property {'list'|'template'|'workspace'} target_type
 * @property {string|null} name
 * @property {string|null} slug
 * @property {string} role
 * @property {string} inviter_account_id
 * @property {number} time_created
 * @property {number} time_expires
 */

/**
 * ADR 0009 §Recipient discovery: fetch pending invitations addressed to
 * one account's verified email. URL convention mirrors
 * `/a/<suffix>/workspaces` (`accountId` is the full prefixed id; the
 * suffix is what goes in the URL).
 *
 * @param {string} accountId
 * @returns {Promise<PendingInvitation[]>}
 */
export async function fetchInvitationsForAccount(accountId) {
	return /** @type {PendingInvitation[]} */ (
		await api.get(`/${accountId}/invitations`)
	);
}
