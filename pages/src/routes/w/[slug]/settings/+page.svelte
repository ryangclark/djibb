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
	// ADR 0011 §Step 10a.4c / ADR 0008: workspace delete is the
	// highest-friction action in the product. It's not Cmd+Z-undoable;
	// instead we render an explicit modal that requires the user to
	// type the workspace name to confirm. The mutator is `archiveList`
	// against the workspace's own id — the post-commit trigger in
	// `_handlePush` enqueues the `cascade-archive` alarm event, which
	// fans out `cascadeArchiveList` to every owned list and template
	// in batches of N=10. The user's click returns instantly; the
	// fan-out finishes in the background. Restoration is a 30-day
	// window via the Trash UI (Step 10b — not yet built); past that
	// the hard-delete clock fires and storage is reclaimed.

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

	// ADR 0008 friction tier: workspace delete requires a typed
	// confirmation against the current workspace name (case-
	// insensitive). The button only enables when the input matches —
	// no accidental Enter, no muscle-memory click-through. While the
	// mutation is in flight `deleting` blocks re-submit and dims the
	// modal.
	let deleteModalOpen = $state(false);
	let deleteConfirmText = $state('');
	let deleting = $state(false);
	const deleteConfirmMatches = $derived(
		deleteConfirmText.trim().toLowerCase() ===
			(workspace?.name ?? '').trim().toLowerCase() &&
			(workspace?.name ?? '').trim().length > 0
	);

	// ADR 0008 / ADR 0011 §Step 10c: Personal workspaces use the
	// "Start Fresh" verb instead of Delete. Same backend cascade —
	// the old workspace + everything in it lands in Trash with a 30d
	// clock — plus an atomic mint of a fresh personal workspace so
	// the user always has exactly one current personal. Same friction
	// posture: type the literal string "Start Fresh" to confirm,
	// matching the case-insensitive pattern Delete uses.
	const START_FRESH_PHRASE = 'Start Fresh';
	let startFreshModalOpen = $state(false);
	let startFreshConfirmText = $state('');
	let startingFresh = $state(false);
	const startFreshConfirmMatches = $derived(
		startFreshConfirmText.trim().toLowerCase() ===
			START_FRESH_PHRASE.toLowerCase()
	);

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

	function openDeleteModal() {
		deleteConfirmText = '';
		error = '';
		deleteModalOpen = true;
	}

	function closeDeleteModal() {
		if (deleting) return;
		deleteModalOpen = false;
	}

	function openStartFreshModal() {
		startFreshConfirmText = '';
		error = '';
		startFreshModalOpen = true;
	}

	function closeStartFreshModal() {
		if (startingFresh) return;
		startFreshModalOpen = false;
	}

	async function onConfirmStartFresh() {
		if (!ctx?.mutate || !workspaceId) return;
		if (!startFreshConfirmMatches) return;
		startingFresh = true;
		error = '';
		try {
			// startFresh against the workspace's own id soft-deletes the
			// current personal workspace (cascade-archives its contents
			// to Trash + arms the 30d harddelete clock) AND mints a
			// fresh new personal workspace for the actor in the DO's
			// post-commit tail. Pass the actor's display name so the
			// new workspace gets the same `<name>'s space` title used
			// at signup.
			const actorAccountId =
				sessionWorkspace?.membership?.account_id ?? null;
			const displayName =
				session.accounts.find((a) => a.id === actorAccountId)
					?.display_name ?? null;
			await ctx.mutate.startFresh({
				workspaceId,
				accountDisplayName: displayName
			});
			// Refresh workspaces so the freshly-minted personal
			// workspace appears in the switcher; the old one drops out
			// (it's now soft-deleted, excluded by the projection
			// filter). Then navigate to /workspaces so the user lands
			// somewhere live — the personal workspace they came from
			// no longer resolves at /w/<old-slug>.
			await session.refreshWorkspaces();
			await goto('/workspaces');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			startingFresh = false;
		}
	}

	async function onConfirmDelete() {
		if (!ctx?.mutate || !workspaceId) return;
		if (!deleteConfirmMatches) return;
		deleting = true;
		error = '';
		try {
			// archiveList against the workspace's own id soft-deletes
			// the workspace entity. The DO's post-commit hook then
			// enqueues `cascade-archive`, which fans out to every owned
			// list and template in batches. Nothing to await here for
			// the cascade — the user's view of "I deleted this" is
			// satisfied the moment archiveList returns. Refresh the
			// session list so the deleted workspace drops from the
			// switcher, and navigate the user away from a URL that's
			// about to stop resolving.
			await ctx.mutate.archiveList({ listId: workspaceId });
			await session.refreshWorkspaces();
			await goto('/workspaces');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			deleting = false;
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
				<button
					class="border border-red-600 text-red-700 px-3 py-1 text-sm"
					onclick={openDeleteModal}
					disabled={deleting}
				>
					Delete workspace…
				</button>
			{:else}
				<button
					class="border border-red-600 text-red-700 px-3 py-1 text-sm"
					onclick={openStartFreshModal}
					disabled={startingFresh}
				>
					Start Fresh…
				</button>
			{/if}
		</div>

		{#if error}
			<p class="text-red-600 text-sm mt-2">{error}</p>
		{/if}
	{/if}
{/if}

{#if startFreshModalOpen && workspace}
	<div class="modal-backdrop" role="dialog" aria-modal="true">
		<div class="modal">
			<h3>Start Fresh?</h3>
			<p>
				Everything in your personal workspace will be moved to the
				trash. You'll have <strong>30 days</strong> to restore any of it
				before it's permanently deleted.
			</p>
			<p>
				A fresh empty personal workspace will be created for you
				right after.
			</p>
			<label class="block mt-3 text-sm">
				Type <strong>{START_FRESH_PHRASE}</strong> to confirm:
				<input
					class="border px-2 py-1 mt-1 block w-full"
					bind:value={startFreshConfirmText}
					placeholder={START_FRESH_PHRASE}
					disabled={startingFresh}
					autocomplete="off"
				/>
			</label>
			<div class="modal-actions">
				<button
					type="button"
					onclick={closeStartFreshModal}
					disabled={startingFresh}
				>
					Cancel
				</button>
				<button
					type="button"
					class="danger"
					onclick={onConfirmStartFresh}
					disabled={!startFreshConfirmMatches || startingFresh}
				>
					{startingFresh ? 'Starting…' : 'Start Fresh'}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if deleteModalOpen && workspace}
	<div class="modal-backdrop" role="dialog" aria-modal="true">
		<div class="modal">
			<h3>Delete this workspace?</h3>
			<p>
				All lists and templates in
				<strong>{workspace.name}</strong>
				will be moved to the trash. You'll have <strong>30 days</strong>
				to restore them before they're permanently deleted.
			</p>
			<p>
				Members of this workspace will lose access immediately.
			</p>
			<label class="block mt-3 text-sm">
				Type <strong>{workspace.name}</strong> to confirm:
				<input
					class="border px-2 py-1 mt-1 block w-full"
					bind:value={deleteConfirmText}
					placeholder={workspace.name}
					disabled={deleting}
					autocomplete="off"
				/>
			</label>
			<div class="modal-actions">
				<button
					type="button"
					onclick={closeDeleteModal}
					disabled={deleting}
				>
					Cancel
				</button>
				<button
					type="button"
					class="danger"
					onclick={onConfirmDelete}
					disabled={!deleteConfirmMatches || deleting}
				>
					{deleting ? 'Deleting…' : 'Delete workspace'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: grid;
		place-items: center;
		z-index: 100;
	}
	.modal {
		background: white;
		padding: 1.5rem;
		border-radius: 0.5rem;
		max-width: 30rem;
		margin: 0 1rem;
	}
	.modal h3 {
		margin: 0 0 0.5rem 0;
		font-weight: 600;
	}
	.modal p {
		margin: 0.5rem 0;
		font-size: 0.875rem;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.modal-actions button {
		border: 1px solid #d6d3d1;
		padding: 0.25rem 0.75rem;
		font-size: 0.875rem;
	}
	.modal-actions button.danger {
		border-color: #dc2626;
		color: #b91c1c;
	}
	.modal-actions button.danger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
