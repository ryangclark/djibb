<script>
	import { fetchWorkspaceMembers } from '$lib/api/workspace';
	import {
		listInvitations,
		createInvitation,
		revokeInvitation,
		changeMemberRole,
		removeMember
	} from '$lib/api/invitation';
	import { page } from '$app/state';
	import { getSessionState } from '$lib/session.svelte';

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
	/** @type {import('$lib/api/invitation').WorkspaceInvitation[]} */
	let invitations = $state([]);
	let error = $state('');

	// Invite form
	/** @type {'email'|'username'|'link'} */
	let inviteType = $state('email');
	let inviteEmail = $state('');
	let inviteUsername = $state('');
	/** @type {number|''} */
	let inviteMaxUses = $state('');
	/** @type {'admin'|'member'|'viewer'} */
	let inviteRole = $state('member');
	let creating = $state(false);
	let lastInviteUrl = $state('');

	async function loadMembers() {
		try {
			members = await fetchWorkspaceMembers(slug);
		} catch (e) {
			error = /** @type {Error} */ (e).message ?? String(e);
		}
	}

	async function loadInvitations() {
		if (!isAdmin || !actorAccountId || isPersonal) {
			invitations = [];
			return;
		}
		try {
			invitations = await listInvitations(slug, actorAccountId);
		} catch (e) {
			error = /** @type {Error} */ (e).message ?? String(e);
		}
	}

	$effect(() => {
		if (!slug) return;
		loadMembers();
		loadInvitations();
	});

	async function onCreateInvite() {
		if (!actorAccountId) return;
		creating = true;
		error = '';
		lastInviteUrl = '';
		try {
			let body;
			if (inviteType === 'email') {
				body = { type: 'email', email: inviteEmail.trim(), role: inviteRole };
			} else if (inviteType === 'username') {
				body = {
					type: 'username',
					username: inviteUsername.trim(),
					role: inviteRole
				};
			} else {
				body = {
					type: 'link',
					max_uses: inviteMaxUses === '' ? null : Number(inviteMaxUses),
					role: inviteRole
				};
			}
			const inv = await createInvitation(slug, body, actorAccountId);
			// Build the user-facing accept URL.
			lastInviteUrl = `${window.location.origin}/invites/${inv.token}`;
			inviteEmail = '';
			inviteUsername = '';
			inviteMaxUses = '';
			await loadInvitations();
		} catch (e) {
			error = /** @type {Error} */ (e).message ?? String(e);
		} finally {
			creating = false;
		}
	}

	/** @param {string} id */
	async function onRevoke(id) {
		if (!actorAccountId) return;
		try {
			await revokeInvitation(slug, id, actorAccountId);
			await loadInvitations();
		} catch (e) {
			error = /** @type {Error} */ (e).message ?? String(e);
		}
	}

	/**
	 * @param {string} accountId
	 * @param {Event} ev
	 */
	async function onChangeRole(accountId, ev) {
		if (!actorAccountId) return;
		const target = /** @type {HTMLSelectElement} */ (ev.target);
		const role = /** @type {'owner'|'admin'|'member'|'viewer'} */ (target.value);
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
							<option value="member">member</option>
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
	<section class="border-t pt-4">
		<h3 class="text-md mb-2">Invite</h3>

		<div class="flex gap-2 items-end mb-3 flex-wrap">
			<label class="flex flex-col text-xs">
				Type
				<select bind:value={inviteType} class="border p-1">
					<option value="email">Email</option>
					<option value="username">Username</option>
					<option value="link">Link</option>
				</select>
			</label>

			{#if inviteType === 'email'}
				<label class="flex flex-col text-xs">
					Email
					<input
						type="email"
						bind:value={inviteEmail}
						class="border p-1"
						placeholder="user@example.com"
					/>
				</label>
			{:else if inviteType === 'username'}
				<label class="flex flex-col text-xs">
					Username
					<input
						type="text"
						bind:value={inviteUsername}
						class="border p-1"
						placeholder="alice"
					/>
				</label>
			{:else}
				<label class="flex flex-col text-xs">
					Max uses (blank = unlimited)
					<input
						type="number"
						min="1"
						max="500"
						bind:value={inviteMaxUses}
						class="border p-1"
					/>
				</label>
			{/if}

			<label class="flex flex-col text-xs">
				Role
				<select bind:value={inviteRole} class="border p-1">
					<option value="admin">admin</option>
					<option value="member">member</option>
					<option value="viewer">viewer</option>
				</select>
			</label>

			<button
				disabled={creating}
				onclick={onCreateInvite}
				class="border px-3 py-1 text-sm">{creating ? 'Sending…' : 'Send invite'}</button
			>
		</div>

		{#if lastInviteUrl}
			<p class="text-xs mb-3">
				Invite created. Share this URL:
				<code class="font-mono break-all">{lastInviteUrl}</code>
			</p>
		{/if}

		<h4 class="text-sm mb-1 text-stone-600">Pending invitations</h4>
		{#if !invitations.length}
			<p class="text-xs text-stone-500">None.</p>
		{:else}
			<table class="text-xs">
				<thead>
					<tr class="text-stone-500">
						<th class="text-left pr-4">Type</th>
						<th class="text-left pr-4">Target</th>
						<th class="text-left pr-4">Role</th>
						<th class="text-left pr-4">Uses</th>
						<th class="text-left pr-4">Expires</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each invitations as inv}
						<tr>
							<td class="pr-4">{inv.type}</td>
							<td class="pr-4 font-mono">
								{inv.target_email ?? inv.target_account_id ?? '(any)'}
							</td>
							<td class="pr-4">{inv.role}</td>
							<td class="pr-4">
								{inv.use_count}{inv.max_uses != null ? `/${inv.max_uses}` : ''}
							</td>
							<td class="pr-4">{new Date(inv.time_expires).toLocaleDateString()}</td>
							<td>
								<button class="text-red-600" onclick={() => onRevoke(inv.id)}>
									Revoke
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
{:else if isPersonal}
	<p class="text-xs text-stone-500">Personal workspaces don't have invitations.</p>
{/if}
