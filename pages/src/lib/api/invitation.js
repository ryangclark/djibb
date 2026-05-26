const BASE = import.meta.env.VITE_API_BASE_URL;

/**
 * @typedef {'email'|'username'|'link'} InvitationType
 * @typedef {'pending'|'accepted'|'revoked'|'expired'} InvitationStatus
 * @typedef {'admin'|'editor'|'viewer'} InvitableRole
 */

/**
 * @typedef {object} WorkspaceInvitation
 * @property {string} id
 * @property {string} workspace_id
 * @property {InvitationType} type
 * @property {string|null} target_email
 * @property {string|null} target_account_id
 * @property {'owner'|'admin'|'editor'|'viewer'} role
 * @property {string} token
 * @property {string} inviter_account_id
 * @property {InvitationStatus} status
 * @property {number|null} max_uses
 * @property {number} use_count
 * @property {string} time_created
 * @property {string} time_expires
 * @property {string|null} time_accepted
 */

/**
 * @typedef {object} InvitationPreview
 * @property {InvitationType} type
 * @property {'owner'|'admin'|'editor'|'viewer'} role
 * @property {{ slug: string, name: string|null, image: string|null }} workspace
 * @property {{ display_name: string }} inviter
 * @property {string} time_expires
 * @property {InvitationStatus} status
 */

/**
 * @param {string|null} actorAccountId
 */
function headers(actorAccountId) {
	/** @type {Record<string, string>} */
	const h = { 'Content-Type': 'application/json' };
	if (actorAccountId) h['X-Djibb-Active-Account'] = actorAccountId;
	return h;
}

/**
 * @param {string} slug
 * @param {string} actorAccountId
 * @returns {Promise<WorkspaceInvitation[]>}
 */
export async function listInvitations(slug, actorAccountId) {
	const res = await fetch(`${BASE}/workspace/${slug}/invitations`, {
		credentials: 'include',
		headers: headers(actorAccountId)
	});
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

/**
 * @param {string} slug
 * @param {{ type: 'email', email: string, role: InvitableRole }
 *        | { type: 'username', username: string, role: InvitableRole }
 *        | { type: 'link', max_uses?: number|null, role: InvitableRole }} body
 * @param {string} actorAccountId
 * @returns {Promise<WorkspaceInvitation>}
 */
export async function createInvitation(slug, body, actorAccountId) {
	const res = await fetch(`${BASE}/workspace/${slug}/invitations`, {
		method: 'POST',
		credentials: 'include',
		headers: headers(actorAccountId),
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

/**
 * @param {string} slug
 * @param {string} invitationId
 * @param {string} actorAccountId
 */
export async function revokeInvitation(slug, invitationId, actorAccountId) {
	const res = await fetch(
		`${BASE}/workspace/${slug}/invitations/${encodeURIComponent(invitationId)}`,
		{
			method: 'DELETE',
			credentials: 'include',
			headers: headers(actorAccountId)
		}
	);
	if (!res.ok) throw new Error(await res.text());
}

/**
 * @param {string} token
 * @returns {Promise<InvitationPreview>}
 */
export async function fetchInvitationPreview(token) {
	const res = await fetch(`${BASE}/invitations/${encodeURIComponent(token)}`, {
		credentials: 'include'
	});
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

/**
 * @param {string} token
 * @param {string} actorAccountId
 * @returns {Promise<{ workspace_id: string, workspace_slug: string, role: string, membership_created: boolean }>}
 */
export async function acceptInvitation(token, actorAccountId) {
	const res = await fetch(
		`${BASE}/invitations/${encodeURIComponent(token)}/accept`,
		{
			method: 'POST',
			credentials: 'include',
			headers: headers(actorAccountId)
		}
	);
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

/**
 * @param {string} slug
 * @param {string} accountId
 * @param {'owner'|'admin'|'editor'|'viewer'} role
 * @param {string} actorAccountId
 */
export async function changeMemberRole(slug, accountId, role, actorAccountId) {
	const res = await fetch(
		`${BASE}/workspace/${slug}/members/${encodeURIComponent(accountId)}`,
		{
			method: 'PATCH',
			credentials: 'include',
			headers: headers(actorAccountId),
			body: JSON.stringify({ role })
		}
	);
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

/**
 * @param {string} slug
 * @param {string} accountId
 * @param {string} actorAccountId
 */
export async function removeMember(slug, accountId, actorAccountId) {
	const res = await fetch(
		`${BASE}/workspace/${slug}/members/${encodeURIComponent(accountId)}`,
		{
			method: 'DELETE',
			credentials: 'include',
			headers: headers(actorAccountId)
		}
	);
	if (!res.ok) throw new Error(await res.text());
}
