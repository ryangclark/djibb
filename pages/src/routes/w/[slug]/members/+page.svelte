<script>
	import { fetchWorkspaceMembers } from '$lib/api/workspace';
	import { changeMemberRole, removeMember } from '$lib/api/workspace';
	import { page } from '$app/state';
	import { getSessionState } from '$lib/session.svelte';

	// ADR 0011 §7b.3: the legacy `WorkspaceInvitation`/`InvitationApp`
	// system was deleted. Invitations now go through the entity-resident
	// ADR 0009 `inviteByIdentity`/`acceptInvitation` mutators surfaced
	// via the `Share` component on individual entities. The
	// workspace-scoped invitation UI (multi-type forms, link tokens,
	// invitation lists) is postponed; 7b.4 rebuilds it on top of the
	// per-entity Share surface or a new workspace-level mutator.

	const session = getSessionState();
	const slug = $derived(page.params.slug);

	const currentWorkspace = $derived(
		session.workspaces.find(w => w.workspace.slug === slug)
	);
	const currentRole = $derived(currentWorkspace?.membership.role ?? null);
	const isAdmin = $derived(currentRole === 'owner' || currentRole === 'admin');
	const isPersonal = $derived(currentWorkspace?.workspace.is_personal ?? false);
	const actorAccountId = $derived(session.currentAccountId);

	/** @type {import('$lib/api/workspace').WorkspaceMember[]} */
	let members = $state([]);
	let error = $state('');

	async function loadMembers() {
		try {
			members = await fetchWorkspaceMembers(slug);
		} catch (e) {
			error = /** @type {Error} */ (e).message ?? String(e);
		}
	}

	$effect(() => {
		if (!slug) return;
		loadMembers();
	});

	/**
	 * @param {string} accountId
	 * @param {Event} ev
	 */
	async function onChangeRole(accountId, ev) {
		if (!actorAccountId) return;
		const target = /** @type {HTMLSelectElement} */ (ev.target);
		const role = /** @type {'owner'|'admin'|'editor'|'viewer'} */ (target.value);
		try {
			await changeMemberRole(slug, accountId, role, actorAccountId);
			await loadMembers();
		} catch (e) {
			error = /** @type {Error} */ (e).message ?? String(e);
			await loadMembers();
		}
	}

	/** @param {string} accountId */
	async function onRemoveMember(accountId) {
		if (!actorAccountId) return;
		if (!confirm('Remove this member?')) return;
		try {
			await removeMember(slug, accountId, actorAccountId);
			await loadMembers();
		} catch (e) {
			error = /** @type {Error} */ (e).message ?? String(e);
		}
	}
</script>

<h2 class="text-lg mb-2">Members</h2>

{#if error}
	<p class="text-red-600 text-sm mb-2">{error}</p>
{/if}

<table class="text-sm mb-6">
	<thead>
		<tr class="text-stone-500">
			<th class="text-left pr-6">Account</th>
			<th class="text-left pr-6">Role</th>
			<th class="text-left pr-6">Joined</th>
			{#if isAdmin && !isPersonal}
				<th class="text-left"></th>
			{/if}
		</tr>
	</thead>
	<tbody>
		{#each members as m}
			<tr>
				<td class="pr-6 font-mono text-xs">{m.account_id}</td>
				<td class="pr-6">
					{#if isAdmin && !isPersonal && m.account_id !== actorAccountId}
						<select value={m.role} onchange={ev => onChangeRole(m.account_id, ev)}>
							<option value="owner">owner</option>
							<option value="admin">admin</option>
							<option value="editor">editor</option>
							<option value="viewer">viewer</option>
						</select>
					{:else}
						{m.role}
					{/if}
				</td>
				<td class="pr-6">{new Date(m.time_joined).toLocaleDateString()}</td>
				{#if isAdmin && !isPersonal}
					<td>
						{#if m.account_id !== actorAccountId}
							<button
								class="text-red-600 text-xs"
								onclick={() => onRemoveMember(m.account_id)}>Remove</button
							>
						{/if}
					</td>
				{/if}
			</tr>
		{/each}
	</tbody>
</table>

{#if isAdmin && !isPersonal}
	<p class="text-xs text-stone-500">
		Workspace-level invitations are temporarily unavailable. Use the
		Share button on individual entities to invite people for now;
		workspace-scoped invitations return in a follow-up.
	</p>
{:else if isPersonal}
	<p class="text-xs text-stone-500">Personal workspaces don't have invitations.</p>
{/if}
