<script>
	import { goto } from '$app/navigation';
	import { getSessionState } from '$lib/session.svelte';
	import { initList } from '$lib/replicache/index.svelte.js';
	import { newId } from '$djibb/id';

	// ADR 0011 §7b.4: workspace create is now a client-side mint:
	// generate a `w/<nanoid>` id, open a Replicache client at that
	// id, dispatch `createWorkspace`, force a push, then refresh and
	// navigate. The legacy `POST /workspace` HTTP path is gone.
	// Slugs are postponed (§7b.5) — only `name` here.

	const session = getSessionState();

	let newName = $state('');
	let actorAccountId = $state('');
	let creating = $state(false);
	let error = $state('');

	$effect(() => {
		if (!actorAccountId && session.accounts.length) {
			actorAccountId = session.accounts[0].id;
		}
	});

	async function submit() {
		error = '';
		creating = true;
		try {
			const workspaceId = newId('workspace');
			const rep = initList({
				accountId: actorAccountId,
				listId: workspaceId,
				skipClientInit: true
			});
			try {
				await rep.mutate.createWorkspace({
					workspaceId,
					name: newName.trim()
				});
				// Wait for the optimistic push to round-trip so the
				// entity row + projection are in D1 before we navigate
				// (the destination layout's /pull would 404 otherwise).
				await rep.client.push?.();
			} finally {
				await rep.client.close();
			}
			await session.refreshWorkspaces();
			newName = '';
			// URL uses the id suffix (slugs postponed). Slug field in
			// the projection mirrors the suffix.
			const suffix = workspaceId.split('/', 2)[1] ?? workspaceId;
			await goto(`/w/${suffix}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		creating = false;
	}
</script>

<div class="flex items-baseline justify-between mb-2">
	<h1 class="text-2xl">Workspaces</h1>
	<a class="text-sm underline text-stone-500" href="/trash">Trash</a>
</div>

{#if !session.accounts.length}
	<p>Sign in to manage workspaces.</p>
{:else}
	<section class="mb-6">
		{#each session.workspaces as ws}
			<div class="my-2 flex items-center gap-3">
				<a class="underline" href={`/w/${ws.workspace.slug}`}>
					{ws.workspace.name ?? (ws.workspace.is_personal ? 'Your space' : ws.workspace.slug)}
				</a>
				<span class="text-xs text-stone-500">
					/{ws.workspace.slug} · {ws.membership.role}
					{#if ws.workspace.is_personal}· personal{/if}
				</span>
			</div>
		{:else}
			<p><i>No workspaces yet.</i></p>
		{/each}
	</section>

	<section class="border-t pt-4">
		<h2 class="text-lg mb-2">New workspace</h2>
		<form onsubmit={(e) => { e.preventDefault(); submit(); }}>
			<label class="block mb-1 text-sm">
				Name
				<input
					class="border px-2 py-1 ml-2"
					bind:value={newName}
					placeholder="My Team 🚀"
					required
				/>
			</label>
			{#if session.accounts.length > 1}
				<label class="block mb-1 text-sm">
					Owning account
					<select bind:value={actorAccountId} class="border px-2 py-1 ml-2">
						{#each session.accounts as a}
							<option value={a.id}>{a.display_name}</option>
						{/each}
					</select>
				</label>
			{/if}
			<button class="border px-3 py-1 mt-2" disabled={creating}>
				{creating ? 'Creating…' : 'Create'}
			</button>
			{#if error}<p class="text-red-600 text-sm mt-2">{error}</p>{/if}
		</form>
	</section>
{/if}
