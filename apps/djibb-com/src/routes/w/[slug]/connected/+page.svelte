<script>
	// Connected-clients access surface (ADR 0022 §6, GH #24). Owner/admin-only
	// view of everything connected to this workspace: each member Account with
	// its interactive sessions and issued tokens (the #23 union read), plus a
	// revoked/expired history. Implements the field/button set the #19
	// prototype locked in (docs/plans/connected-clients-surface.md).
	//
	// Manager-revoke is entity-scoped (the locked-in rule): a manager severs
	// access to *this workspace*, never to an Account. So:
	//   - a token bound to THIS workspace → Revoke (real credential revoke);
	//   - a member / bot → "Remove" (the existing removeMember mutator, which
	//     drops their grant without touching their account);
	//   - account-wide sessions + unbound tokens → shown for visibility, but
	//     marked "owner-only" with no manager action (out of a manager's reach).
	import { getContext, untrack } from 'svelte';
	import { getSessionState } from '$lib/session.svelte';
	import { WORKSPACE_REPLICACHE_KEY } from '../_context.js';
	import {
		fetchConnectedClients,
		revokeConnectedCredential
	} from '$lib/api/connected.js';

	const session = getSessionState();
	/** @type {any} */
	const ctx = getContext(WORKSPACE_REPLICACHE_KEY);

	const workspaceId = $derived(ctx?.workspaceId ?? null);
	const role = $derived(ctx?.sessionWorkspace?.membership?.role ?? null);
	const canView = $derived(role === 'owner' || role === 'admin');
	const actorAccountId = $derived(
		ctx?.sessionWorkspace?.membership?.account_id ?? null
	);

	/** @type {import('$lib/api/connected.js').ConnectedSurface | null} */
	let surface = $state(null);
	let loading = $state(false);
	let showHistory = $state(false);
	/** @type {string | null} */
	let error = $state(null);

	async function load() {
		if (!workspaceId || loading) return;
		loading = true;
		error = null;
		try {
			surface = await fetchConnectedClients({
				workspaceId,
				accountId: session.currentAccountId
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		loading = false;
	}

	$effect(() => {
		if (canView && workspaceId) untrack(() => void load());
	});

	// Group the active clients under each member Account, so the surface reads
	// as an enriched roster rather than a flat list. A member with no live
	// session/token still appears (they have access; they're just not
	// currently connected).
	const grouped = $derived.by(() => {
		const s = surface;
		if (!s) return [];
		return s.accounts.map((acct) => ({
			...acct,
			clients: s.active.filter((c) => c.account_id === acct.account_id)
		}));
	});

	/** @param {import('$lib/api/connected.js').ConnectedClient} c */
	function isEntityBoundToken(c) {
		return c.kind === 'token' && c.bound_entity_id === workspaceId;
	}

	/** @param {number | null} ts unix seconds */
	function when(ts) {
		if (ts == null) return '—';
		return new Date(ts * 1000).toLocaleString();
	}

	/** @param {import('$lib/api/connected.js').ConnectedAccount} acct */
	function actorName(acct) {
		const name = acct.display_name || acct.email || acct.account_id;
		return acct.account_id === actorAccountId ? `${name} (you)` : name;
	}

	/** @param {string} credentialId */
	async function onRevokeToken(credentialId) {
		if (!workspaceId) return;
		if (!confirm('Revoke this token? It will lose access to this workspace.'))
			return;
		try {
			await revokeConnectedCredential({
				workspaceId,
				credentialId,
				accountId: session.currentAccountId
			});
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	/** @param {string} targetAccountId */
	async function onRemoveMember(targetAccountId) {
		if (!ctx?.mutate || !workspaceId) return;
		if (!confirm('Remove this member’s access to the workspace?')) return;
		try {
			await ctx.mutate.removeMember({ listId: workspaceId, targetAccountId });
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
</script>

<section>
	<h2 class="text-xl mb-1">Connected clients</h2>
	<p class="text-sm text-stone-500 mb-4">
		Everything connected to this workspace — members, their sign-ins, and
		issued tokens. Revoking here removes access to <em>this workspace</em>,
		never to someone’s whole account.
	</p>

	{#if !canView}
		<p class="text-sm text-stone-500">
			Only workspace owners and admins can view connected clients.
		</p>
	{:else if error}
		<p class="text-sm text-red-600">Couldn’t load connected clients: {error}</p>
		<button class="border px-3 py-1 mt-2 text-sm" onclick={() => load()}>
			Retry
		</button>
	{:else if !surface}
		<p class="text-sm text-stone-500">Loading…</p>
	{:else}
		<ul class="divide-y">
			{#each grouped as acct (acct.account_id)}
				<li class="py-3">
					<div class="flex items-baseline gap-3">
						<strong class="text-sm">{actorName(acct)}</strong>
						<span class="text-xs text-stone-500">{acct.role}</span>
						{#if acct.account_id !== actorAccountId}
							<button
								class="text-red-600 text-xs ml-auto"
								onclick={() => onRemoveMember(acct.account_id)}
							>
								Remove from workspace
							</button>
						{/if}
					</div>

					{#if acct.clients.length === 0}
						<p class="text-xs text-stone-400 mt-1 ml-4">
							No active session or token.
						</p>
					{:else}
						<ul class="mt-1 ml-4 text-sm">
							{#each acct.clients as c (c.id)}
								<li class="flex items-baseline gap-3 py-1">
									<span
										class="inline-block rounded px-1.5 py-0.5 text-xs {c.kind ===
										'token'
											? 'bg-violet-100 text-violet-800'
											: 'bg-sky-100 text-sky-800'}"
									>
										{c.kind}
									</span>
									<span>
										{c.label ?? (c.kind === 'session' ? 'sign-in' : c.id)}
										{#if c.bound_entity_id === workspaceId}
											<span class="text-xs text-stone-400">· bound here</span>
										{/if}
									</span>
									<span class="text-xs text-stone-500 ml-auto whitespace-nowrap">
										last used {when(c.time_last_used)}
									</span>
									{#if isEntityBoundToken(c)}
										<button
											class="text-red-600 text-xs"
											onclick={() => onRevokeToken(c.id)}>Revoke</button
										>
									{:else}
										<span class="text-xs text-stone-400">owner-only</span>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>

		<button
			class="text-xs text-stone-500 underline mt-4"
			onclick={() => (showHistory = !showHistory)}
		>
			{showHistory ? '▾' : '▸'} Credential history (revoked / expired) — {surface
				.history.length}
		</button>

		{#if showHistory}
			{#if surface.history.length === 0}
				<p class="text-xs text-stone-400 mt-2">No revoked or expired clients.</p>
			{:else}
				<ul class="mt-2 text-sm divide-y text-stone-400">
					{#each surface.history as c (c.id)}
						<li class="flex items-baseline gap-3 py-1">
							<span class="text-xs uppercase">{c.state}</span>
							<span>{c.label ?? c.id}</span>
							<span class="text-xs ml-auto whitespace-nowrap">
								created {when(c.time_created)}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	{/if}
</section>
