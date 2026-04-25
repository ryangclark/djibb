<script>
	import { getSessionState } from '$lib/session.svelte';
	import { createWorkspace } from '$lib/api/workspace';

	const session = getSessionState();

	let newSlug = $state('');
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
			await createWorkspace(
				{ slug: newSlug.trim(), name: newName.trim() },
				actorAccountId
			);
			newSlug = '';
			newName = '';
			await session.refreshWorkspaces();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		creating = false;
	}
</script>

<h1 class="text-2xl mb-2">Workspaces</h1>

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
		<form onsubmit={e => { e.preventDefault(); submit(); }}>
			<label class="block mb-1 text-sm">
				Slug
				<input
					class="border px-2 py-1 ml-2"
					bind:value={newSlug}
					placeholder="my-team"
					required
				/>
			</label>
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
