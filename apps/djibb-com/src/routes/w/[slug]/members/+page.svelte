<script>
	import { getContext } from 'svelte';
	import { WORKSPACE_REPLICACHE_KEY } from '../_context.js';
	import EntityInvites from '$lib/components/EntityInvites.svelte';

	// ADR 0011 §7b.4: members are now read from the live workspace
	// entity's `authorization_rules.authorized_accounts` (Replicache
	// subscription), and `changeMemberRole`/`removeMember` dispatch
	// through DO mutators. The legacy HTTP `fetchWorkspaceMembers` /
	// `changeMemberRole` / `removeMember` helpers are gone.
	//
	// ADR 0011 §Step 10d: workspace invitations collapse onto ADR 0009.
	// Workspaces are DjibbLists, so `inviteByIdentity` / `revokeInvitation`
	// work against the workspace DO unchanged; the shared `EntityInvites`
	// component drives the invite/pending/revoke surface below, fed by the
	// `pending_invites/*` keyspace exposed on the layout context.

	const ctx = getContext(WORKSPACE_REPLICACHE_KEY);

	const workspace = $derived(ctx?.workspace ?? null);
	const sessionWorkspace = $derived(ctx?.sessionWorkspace ?? null);
	const workspaceId = $derived(ctx?.workspaceId ?? null);
	const pendingInvites = $derived(ctx?.pendingInvites ?? []);

	// Workspace invites never offer `owner` (single-owner invariant) or
	// `checker` (not a workspace role) — narrower than the entity default.
	const WORKSPACE_INVITE_ROLES = /** @type {const} */ ([
		'admin',
		'editor',
		'viewer'
	]);

	const currentRole = $derived(sessionWorkspace?.membership?.role ?? null);
	const isAdmin = $derived(currentRole === 'owner' || currentRole === 'admin');
	const isPersonal = $derived(
		sessionWorkspace?.workspace?.is_personal ?? false
	);
	const actorAccountId = $derived(
		sessionWorkspace?.membership?.account_id ?? null
	);

	/** @type {Array<{account_id: string, role: string}>} */
	const members = $derived.by(() => {
		const grants = workspace?.authorization_rules?.authorized_accounts ?? {};
		return Object.entries(grants).map(
			([account_id, /** @type {any} */ entry]) => ({
				account_id,
				role: entry?.role ?? 'viewer'
			})
		);
	});

	let error = $state('');

	/**
	 * @param {string} accountId
	 * @param {Event} ev
	 */
	async function onChangeRole(accountId, ev) {
		if (!ctx?.mutate || !workspaceId) return;
		const target = /** @type {HTMLSelectElement} */ (ev.target);
		const role = /** @type {'owner'|'admin'|'editor'|'viewer'} */ (
			target.value
		);
		try {
			await ctx.mutate.changeMemberRole({
				listId: workspaceId,
				targetAccountId: accountId,
				role
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	/** @param {string} accountId */
	async function onRemoveMember(accountId) {
		if (!ctx?.mutate || !workspaceId) return;
		if (!confirm('Remove this member?')) return;
		try {
			await ctx.mutate.removeMember({
				listId: workspaceId,
				targetAccountId: accountId
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
</script>

<h2 class="text-lg mb-2">Members</h2>

{#if error}
	<p class="text-red-600 text-sm mb-2">{error}</p>
{/if}

{#if !workspace}
	<p class="text-sm text-stone-500">Loading…</p>
{:else}
	<table class="text-sm mb-6">
		<thead>
			<tr class="text-stone-500">
				<th class="text-left pr-6">Account</th>
				<th class="text-left pr-6">Role</th>
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
							<select
								value={m.role}
								onchange={(ev) => onChangeRole(m.account_id, ev)}
							>
								<option value="owner">owner</option>
								<option value="admin">admin</option>
								<option value="editor">editor</option>
								<option value="viewer">viewer</option>
							</select>
						{:else}
							{m.role}
						{/if}
					</td>
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

	{#if isAdmin && !isPersonal && ctx?.mutate && workspaceId}
		<EntityInvites
			entityId={workspaceId}
			mutators={ctx.mutate}
			currentAccountId={actorAccountId}
			{pendingInvites}
			assignableRoles={WORKSPACE_INVITE_ROLES}
		/>
	{:else if isPersonal}
		<p class="text-xs text-stone-500">
			Personal workspaces don't have invitations.
		</p>
	{/if}
{/if}
