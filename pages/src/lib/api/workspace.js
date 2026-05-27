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
 * ADR 0011 §7b.4: the legacy HTTP write helpers (`createWorkspace`,
 * `updateWorkspace`, `deleteWorkspace`, `leaveWorkspace`,
 * `changeMemberRole`, `removeMember`, `fetchWorkspaceMembers`,
 * `fetchWorkspace`) are gone. Workspace mutations dispatch through DO
 * mutators via Replicache (see `/w/[slug]/+layout.svelte` for member
 * + settings; `/workspaces/+page.svelte` for create). Member reads
 * come from the live entity's `authorization_rules.authorized_accounts`
 * over the Replicache subscription. The only HTTP read here is the
 * top-level workspace list, served by the `entity_memberships`
 * projection at `/a/<id>/workspaces`.
 *
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
