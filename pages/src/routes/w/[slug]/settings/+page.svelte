<script>
	import { getSessionState } from '$lib/session.svelte';
	import { updateWorkspace, deleteWorkspace, leaveWorkspace } from '$lib/api/workspace';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	const session = getSessionState();
	const slug = $derived(page.params.slug);
	const current = $derived(
		session.workspaces.find(w => w.workspace.slug === slug)
	);

	let nameDraft = $state('');
	let slugDraft = $state('');
	let saving = $state(false);
	let error = $state('');

	$effect(() => {
		if (current) {
			nameDraft = current.workspace.name ?? '';
			slugDraft = current.workspace.slug;
		}
	});

	async function save() {
		if (!current) return;
		// Capture before any await — the `current` derived can be torn
		// down once we navigate to the new slug, which would trigger
		// Svelte's `derived_inert` warning if we read it after the await.
		const oldSlug = current.workspace.slug;
		const newSlug = slugDraft;
		const accountId = current.membership.account_id;

		saving = true;
		error = '';
		try {
			await updateWorkspace(
				oldSlug,
				{ name: nameDraft || null, slug: newSlug },
				accountId
			);
			await session.refreshWorkspaces();
			if (newSlug !== oldSlug) {
				await goto(`/w/${newSlug}/settings`);
				return; // page is unmounting, don't touch local state
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		saving = false;
	}

	async function onDelete() {
		if (!current) return;
		// TODO: replace this with a 30-day soft-delete trash before hard delete.
		if (!confirm('Delete this workspace?')) return;
		const slug = current.workspace.slug;
		const accountId = current.membership.account_id;
		try {
			await deleteWorkspace(slug, accountId);
			await session.refreshWorkspaces();
			await goto('/workspaces');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function onLeave() {
		if (!current) return;
		if (!confirm('Leave this workspace?')) return;
		const slug = current.workspace.slug;
		const accountId = current.membership.account_id;
		try {
			await leaveWorkspace(slug, accountId);
			await session.refreshWorkspaces();
			await goto('/workspaces');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
</script>

{#if current}
	<h2 class="text-lg mb-2">Settings</h2>
	<form onsubmit={e => { e.preventDefault(); save(); }}>
		<label class="block mb-2 text-sm">
			Name
			<input class="border px-2 py-1 ml-2" bind:value={nameDraft} />
		</label>
		<label class="block mb-2 text-sm">
			Slug
			<input class="border px-2 py-1 ml-2" bind:value={slugDraft} />
		</label>
		<button class="border px-3 py-1" disabled={saving}>
			{saving ? 'Saving…' : 'Save'}
		</button>
	</form>

	<div class="mt-6 flex gap-3">
		{#if !current.workspace.is_personal}
			<button class="border px-3 py-1 text-sm" onclick={onLeave}>Leave</button>
			{#if current.membership.role === 'owner'}
				<button
					class="border px-3 py-1 text-sm text-red-600"
					onclick={onDelete}
				>
					Delete
				</button>
			{/if}
		{:else}
			<p class="text-sm text-stone-500">
				Personal workspaces cannot be deleted or left.
			</p>
		{/if}
	</div>

	{#if error}
		<p class="text-red-600 text-sm mt-2">{error}</p>
	{/if}
{/if}
