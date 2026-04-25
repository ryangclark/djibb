<script>
	import { getSessionState, STATUSES } from '$lib/session.svelte';
	import { goto } from '$app/navigation';

	const session = getSessionState();

	let open = $state(false);
	const loading = $derived(session.status === STATUSES.loading);
	const empty = $derived(!loading && session.workspaces.length === 0);

	const groups = $derived.by(() => {
		/** @type {Map<string, { account: any, items: import('$lib/api/workspace').WorkspaceWithMembership[] }>} */
		const byAccount = new Map();
		for (const account of session.accounts) {
			byAccount.set(account.id, { account, items: [] });
		}
		for (const ws of session.workspaces) {
			const bucket = byAccount.get(ws.membership.account_id);
			if (bucket) bucket.items.push(ws);
		}
		return Array.from(byAccount.values()).filter(g => g.items.length);
	});

	const current = $derived(
		session.workspaces.find(w => w.workspace.slug === session.currentWorkspaceSlug)
			?.workspace
	);

	function workspaceLabel(/** @type {import('$lib/api/workspace').Workspace} */ ws) {
		if (ws.name) return ws.name;
		return ws.is_personal ? 'Your space' : ws.slug;
	}

	/** @param {string} slug */
	function pick(slug) {
		session.setActiveWorkspace(slug);
		open = false;
		goto(`/w/${slug}`);
	}
</script>

{#if session.accounts.length}
	<div class="relative inline-block">
		<button
			class="px-3 py-1 border rounded text-sm"
			onclick={() => (open = !open)}
			disabled={loading}
		>
			{#if loading}
				Loading… ▾
			{:else if empty}
				No workspaces ▾
			{:else}
				{current ? workspaceLabel(current) : 'Choose workspace'} ▾
			{/if}
		</button>
		{#if open}
			<div
				class="absolute mt-1 right-0 z-10 bg-white border rounded shadow min-w-56 max-h-96 overflow-auto"
			>
				{#if empty}
					<div class="px-3 py-2 text-sm text-stone-500">
						You don't belong to any workspaces yet.
					</div>
					<a
						class="block px-3 py-2 text-sm hover:bg-stone-100 border-t"
						href="/workspaces"
						onclick={() => (open = false)}
					>
						Create a workspace →
					</a>
				{:else}
					{#each groups as group}
						<div class="px-3 py-1 text-xs text-stone-500">
							{group.account.display_name}
						</div>
						{#each group.items as ws}
							<button
								class="block w-full text-left px-3 py-1 hover:bg-stone-100 text-sm"
								onclick={() => pick(ws.workspace.slug)}
							>
								{workspaceLabel(ws.workspace)}
								{#if ws.workspace.is_personal}
									<span class="text-xs text-stone-400">(personal)</span>
								{/if}
							</button>
						{/each}
					{/each}
					<a
						class="block px-3 py-2 text-sm hover:bg-stone-100 border-t"
						href="/workspaces"
						onclick={() => (open = false)}
					>
						Manage workspaces…
					</a>
				{/if}
			</div>
		{/if}
	</div>
{/if}
