const BASE = import.meta.env.VITE_API_BASE_URL;

/**
 * @typedef {object} Workspace
 * @property {string} id
 * @property {string} slug
 * @property {string|null} name
 * @property {boolean} is_personal
 * @property {string|null} flags
 * @property {string|null} image
 * @property {string} time_created
 * @property {string|null} time_deleted
 * @property {string} time_updated
 */

/**
 * @typedef {object} WorkspaceMember
 * @property {string} account_id
 * @property {'owner'|'admin'|'editor'|'viewer'} role
 * @property {string[]} permissions
 * @property {string} time_joined
 */

/**
 * @typedef {object} WorkspaceWithMembership
 * @property {Workspace} workspace
 * @property {WorkspaceMember} membership
 */

/**
 * @param {string|null} actorAccountId
 * @returns {Record<string, string>}
 */
function headers(actorAccountId) {
	/** @type {Record<string, string>} */
	const h = { 'Content-Type': 'application/json' };
	if (actorAccountId) h['X-Djibb-Active-Account'] = actorAccountId;
	return h;
}

/**
 * `accountId` is the full prefixed ID (e.g. "a/0Hb..."). The URL is
 * `/a/<suffix>/workspaces` — the type prefix on the ID becomes the
 * URL prefix.
 * @param {string} accountId
 * @returns {Promise<WorkspaceWithMembership[]>}
 */
export async function fetchWorkspacesForAccount(accountId) {
	const res = await fetch(`${BASE}/${accountId}/workspaces`, {
		credentials: 'include'
	});
	if (!res.ok) throw new Error(`workspaces fetch failed: ${res.status}`);
	return res.json();
}

/**
 * @param {string} slug
 * @returns {Promise<Workspace>}
 */
export async function fetchWorkspace(slug) {
	const res = await fetch(`${BASE}/workspace/${slug}`, {
		credentials: 'include'
	});
	if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
	return res.json();
}

/**
 * @param {string} slug
 * @returns {Promise<WorkspaceMember[]>}
 */
export async function fetchWorkspaceMembers(slug) {
	const res = await fetch(`${BASE}/workspace/${slug}/members`, {
		credentials: 'include'
	});
	if (!res.ok) throw new Error(`members fetch failed: ${res.status}`);
	return res.json();
}

/**
 * @param {{ slug: string, name: string }} body
 * @param {string} actorAccountId
 * @returns {Promise<Workspace>}
 */
export async function createWorkspace(body, actorAccountId) {
	const res = await fetch(`${BASE}/workspace`, {
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
 * @param {{ slug?: string, name?: string|null, image?: string|null }} patch
 * @param {string} actorAccountId
 * @returns {Promise<Workspace>}
 */
export async function updateWorkspace(slug, patch, actorAccountId) {
	const res = await fetch(`${BASE}/workspace/${slug}`, {
		method: 'PATCH',
		credentials: 'include',
		headers: headers(actorAccountId),
		body: JSON.stringify(patch)
	});
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

/**
 * @param {string} slug
 * @param {string} actorAccountId
 */
export async function deleteWorkspace(slug, actorAccountId) {
	const res = await fetch(`${BASE}/workspace/${slug}`, {
		method: 'DELETE',
		credentials: 'include',
		headers: headers(actorAccountId)
	});
	if (!res.ok) throw new Error(await res.text());
}

/**
 * @param {string} slug
 * @param {string} actorAccountId
 */
export async function leaveWorkspace(slug, actorAccountId) {
	const res = await fetch(`${BASE}/workspace/${slug}/leave`, {
		method: 'POST',
		credentials: 'include',
		headers: headers(actorAccountId)
	});
	if (!res.ok) throw new Error(await res.text());
}

/**
 * ADR 0011 §7b.3: member-management helpers moved here from
 * `$lib/api/invitation` (which was deleted). They still call the
 * legacy `/workspace/:slug/members/...` HTTP endpoints; 7b.4 collapses
 * them onto DO mutator dispatch.
 *
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
