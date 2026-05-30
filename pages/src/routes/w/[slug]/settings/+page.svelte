<script>
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { getSessionState } from '$lib/session.svelte';
	import { WORKSPACE_REPLICACHE_KEY } from '../_context.js';

	// ADR 0011 §7b.4 + 7b.5: settings dispatches through DO mutators
	// (`renameWorkspace`, `setWorkspaceSlug`, `setWorkspaceImage`,
	// `leaveMember`). The slug claim rides on `setWorkspaceSlug` with
	// an in-DO preflight that arbitrates against the D1
	// `UNIQUE(type, slug)` index — failures surface over the outcome
	// channel as `slug_taken` / `slug_reserved` / `slug_invalid` /
	// `unauthorized_role`; the layout captures the latest outcome
	// into `ctx.lastOutcome` and we read it here. On success we
	// navigate to the new slug URL.
	//
	// Workspace delete is still dropped (no
	// `archiveWorkspace`/`softDeleteWorkspace` mutator yet; lands
	// with the cascade-delete dispatcher in ADR 0011 §Step 10).

	const session = getSessionState();
	const ctx = getContext(WORKSPACE_REPLICACHE_KEY);

	const workspace = $derived(ctx?.workspace ?? null);
	const sessionWorkspace = $derived(ctx?.sessionWorkspace ?? null);
	const workspaceId = $derived(ctx?.workspaceId ?? null);
	const currentSlug = $derived(sessionWorkspace?.workspace?.slug ?? '');

	let nameDraft = $state('');
	let slugDraft = $state('');
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
		slugDraft = currentSlug;
		const meta = workspace.meta ?? null;
		imageDraft = meta?.image_url ?? '';
		synced = true;
	});
	$effect(() => {
		// Reset synced flag if we navigate to a different workspace.
		void workspaceId;
		synced = false;
	});

	// Watch for slug-specific outcomes. The reason taxonomy comes from
	// `workers/src/list/slug.ts::SlugClaimFailureReason` plus the
	// preflight's `unauthorized_role`. Cleared from context on
	// consumption so a retry sees fresh state.
	const SLUG_FAILURE_REASONS = new Set([
		'slug_taken',
		'slug_reserved',
		'slug_invalid',
		'entity_missing',
		'unauthorized_role'
	]);

	/**
	 * @param {string | undefined} reason
	 * @param {string | undefined} message
	 * @returns {string}
	 */
	function slugFailureCopy(reason, message) {
		switch (reason) {
			case 'slug_taken':
				return 'That slug is already in use by another workspace.';
			case 'slug_reserved':
				return 'That slug is reserved — try another.';
			case 'slug_invalid':
				return 'Slugs must be 3–40 characters: lowercase letters, numbers, and hyphens (no leading or trailing hyphen).';
			case 'entity_missing':
				return 'Workspace not found — refresh and try again.';
			case 'unauthorized_role':
				return 'Only workspace admins and owners can change the slug.';
			default:
				return message || 'Could not save the new slug.';
		}
	}

	$effect(() => {
		const outcome = ctx?.lastOutcome;
		if (!outcome) return;
		if (!outcome.reason || !SLUG_FAILURE_REASONS.has(outcome.reason)) return;
		// Surface the failure and reset the slug draft to the live
		// value so the form reflects what the server actually has.
		error = slugFailureCopy(outcome.reason, outcome.message);
		slugDraft = currentSlug;
		ctx.clearOutcome?.();
		saving = false;
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
			const trimmedSlug = slugDraft.trim();
			const slugChanged = trimmedSlug && trimmedSlug !== currentSlug;
			if (slugChanged) {
				await ctx.mutate.setWorkspaceSlug({
					workspaceId,
					slug: trimmedSlug
				});
				// Replicache optimistically updated the local cache;
				// the preflight may still reject. We can't tell yet —
				// poll session.workspaces after a brief wait. If the
				// server slug matches our draft, the claim succeeded
				// and we navigate; if not, the $effect above will
				// have already surfaced the failure outcome and we
				// stay put.
				await session.refreshWorkspaces();
				const updated = session.workspaces.find(
					w => w.workspace.id === workspaceId
				);
				if (updated?.workspace.slug === trimmedSlug) {
					await goto(`/w/${trimmedSlug}/settings`);
					saving = false;
					return;
				}
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
				Slug
				<input
					class="border px-2 py-1 ml-2"
					bind:value={slugDraft}
					placeholder="my-team"
					pattern="[a-z0-9](?:[a-z0-9-]{'{'}1,38{'}'}[a-z0-9])?"
					maxlength="40"
				/>
				<span class="text-xs text-stone-500 ml-2">/w/{slugDraft || currentSlug}</span>
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
