// Connected-clients access surface (ADR 0022 §6, GH #24). Owner/admin-only
// view of everything connected to a workspace — member Accounts with their
// interactive sessions and issued tokens (the #23 union read). Served by the
// entity router's `/connected` endpoint (manager-gated; 403 otherwise), the
// same backend that serves the workspace's sync and audit log.
//
// Manager-revoke is *entity-scoped* by construction (the locked-in scope
// rule, #24): `revokeConnectedCredential` can only sever a token bound to
// this entity. Account-wide sessions and unbound tokens are shown for
// visibility but are the owner's own to manage — there is no client call to
// revoke them here. Removing a member or bot's access is `removeMember`
// (the existing roster mutator), not this module.

// @ts-check
import { api, DjibbHttpError } from './client.js';

/**
 * One connected principal, mirroring `ConnectedClient` on the server
 * (`src/auth/connected.ts`). Times are unix **seconds**.
 *
 * @typedef {object} ConnectedClient
 * @property {'session'|'token'} kind
 * @property {string} id Session id or public credential_id.
 * @property {string} account_id The Account this acts as.
 * @property {string|null} label Token label; null for sessions.
 * @property {string|null} bound_entity_id Token binding; null = account-wide.
 * @property {number} time_created
 * @property {number|null} time_last_used Tokens only; null for sessions.
 * @property {number|null} time_expires null = non-expiring token.
 * @property {'active'|'revoked'|'expired'} state
 */

/**
 * A member Account on the entity, with display fields for rendering.
 *
 * @typedef {object} ConnectedAccount
 * @property {string} account_id
 * @property {string} role
 * @property {string|null} display_name
 * @property {string|null} email
 */

/**
 * @typedef {object} ConnectedSurface
 * @property {ConnectedAccount[]} accounts Member roster (humans + bots).
 * @property {ConnectedClient[]} active Active sessions + tokens.
 * @property {ConnectedClient[]} history Revoked/expired tokens, expired sessions.
 */

/**
 * Fetch the connected-clients surface for a workspace (owner/admin only).
 *
 * @param {object} input
 * @param {string} input.workspaceId Full prefixed id (e.g. "w/0Hb…").
 * @param {string|null} [input.accountId] Active account; pins role
 *   resolution via the `X-Djibb-Active-Account` header.
 * @returns {Promise<ConnectedSurface>}
 */
export async function fetchConnectedClients({ workspaceId, accountId = null }) {
	const params = new URLSearchParams({ l: workspaceId });
	try {
		return /** @type {ConnectedSurface} */ (
			await api.get(`/workspace/connected?${params}`, { activeAccount: accountId })
		);
	} catch (err) {
		if (err instanceof DjibbHttpError && err.status === 403) {
			throw new Error('forbidden');
		}
		throw err;
	}
}

/**
 * Revoke a token **bound to this workspace** (entity-scoped manager action).
 * The server refuses anything not bound here (account-wide / other-entity /
 * already-revoked) with a 401, so a non-revocable row should not offer this.
 *
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} input.credentialId
 * @param {string|null} [input.accountId]
 * @returns {Promise<void>}
 */
export async function revokeConnectedCredential({
	workspaceId,
	credentialId,
	accountId = null
}) {
	const params = new URLSearchParams({ l: workspaceId });
	await api.post(`/workspace/connected/revoke?${params}`, {
		activeAccount: accountId,
		json: { credentialId }
	});
}
