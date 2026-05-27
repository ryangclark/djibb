<script>
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { getSessionState } from '$lib/session.svelte';
	import { WORKSPACE_REPLICACHE_KEY } from '../_context.js';

	// ADR 0011 §7b.4: settings dispatches through DO mutators
	// (`renameWorkspace`, `setWorkspaceImage`, `leaveMember`). Slug
	// editing is dropped — slugs are postponed (§7b.5). Workspace
	// delete is dropped too: no `archiveWorkspace`/`softDeleteWorkspace`
	// mutator exists yet (that lands with the cascade-delete dispatcher
	// in ADR 0011 §Step 10). The legacy `updateWorkspace`/
	// `deleteWorkspace`/`leaveWorkspace` HTTP helpers are gone.

	const session = getSessionState();
	const ctx = getContext(WORKSPACE_REPLICACHE_KEY);

	const workspace = $derived(ctx?.workspace ?? null);
	const sessionWorkspace = $derived(ctx?.sessionWorkspace ?? null);
	const workspaceId = $derived(ctx?.workspaceId ?? null);

	let nameDraft = $state('');
	let imageDraft = $state('');
	let saving = $state(false);
	let leaving = $state(false);
	let error = $state('');

	let synced = $state(false);
	$effect(() => {
		// Seed drafts from the live entity row once it lands. Re-seed
		// whenever the underlying ID changes (slug navigation between
		// workspaces) so we don't carry drafts across.
		if (!workspace || !workspaceId) return;
		if (synced) return;
		nameDraft = workspace.name ?? '';
		const meta = workspace.meta ?? null;
		imageDraft = meta?.image_url ?? '';
		synced = true;
	});
	$effect(() => {
		// Reset synced flag if we navigate to a different workspace.
		void workspaceId;
		synced = false;
	});

	async function save() {
		if (!ctx?.mutate || !workspaceId) return;
		saving = true;
		error = '';
		try {
			const trimmedName = nameDraft.trim();
			if (trimmedName && trimmedName !== (workspace?.name ?? '')) {
				await ctx.mutate.renameWorkspace({
					workspaceId,
					name: trimmedName
				});
			}
			const trimmedImage = imageDraft.trim();
			const currentImage = workspace?.meta?.image_url ?? '';
			if (trimmedImage !== currentImage) {
				await ctx.mutate.setWorkspaceImage({
					workspaceId,
					image: trimmedImage || null
				});
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		saving = false;
	}

	async function onLeave() {
		if (!ctx?.mutate || !workspaceId) return;
		if (!confirm('Leave this workspace?')) return;
		leaving = true;
		error = '';
		try {
			await ctx.mutate.leaveMember({ listId: workspaceId });
			await session.refreshWorkspaces();
			await goto('/workspaces');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			leaving = false;
		}
	}
</script>

{#if sessionWorkspace}
	<h2 class="text-lg mb-2">Settings</h2>
	{#if !workspace}
		<p class="text-sm text-stone-500">Loading…</p>
	{:else}
		<form onsubmit={(e) => { e.preventDefault(); save(); }}>
			<label class="block mb-2 text-sm">
				Name
				<input class="border px-2 py-1 ml-2" bind:value={nameDraft} />
			</label>
			<label class="block mb-2 text-sm">
				Image URL
				<input
					class="border px-2 py-1 ml-2"
					bind:value={imageDraft}
					placeholder="https://…"
				/>
			</label>
			<button class="border px-3 py-1" disabled={saving}>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</form>

		<div class="mt-6 flex gap-3">
			{#if !sessionWorkspace.workspace.is_personal}
				<button
					class="border px-3 py-1 text-sm"
					onclick={onLeave}
					disabled={leaving}
				>
					{leaving ? 'Leaving…' : 'Leave'}
				</button>
				<!-- ADR 0011 §7b.4: delete is dropped until the workspace
				     cascade-delete dispatcher lands (Step 10). The legacy
				     `softDeleteWorkspace` HTTP path is gone. -->
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
{/if}
