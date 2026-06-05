<script>
	import { getSessionState } from '$lib/session.svelte';
	import { fetchTrashForAccount } from '$lib/api/trash';
	import { initList } from '$lib/replicache/index.svelte.js';

	// ADR 0011 §Step 10b-ui / ADR 0008: per-account Trash. Aggregates
	// soft-deleted entities the actor owns across every account in the
	// session. The server endpoint already filters by `role = 'owner'`
	// and excludes cascade-archived children (children whose
	// `cascade_source` points at a soft-deleted workspace come back
	// via cascade-restore (10a.5) when the workspace is restored —
	// surfacing them here would invite per-row Restore actions that
	// race the workspace-level sweep).
	//
	// Restore wiring: the entity is soft-deleted, so we don't have a
	// live Replicache context to fire `mutate.unarchiveList` against.
	// Same pattern as `/workspaces` create — open a fresh client at
	// the entity's id, dispatch the mutation, force a push to land
	// it server-side, then close. For workspaces we also refresh the
	// session's workspace list so the restored workspace reappears
	// in the switcher; cascade-restore (10a.5) brings the children
	// back asynchronously, so a manual list refresh isn't needed.

	const session = getSessionState();

	/** @type {Map<string, import('$lib/api/trash').TrashedEntity[]>} */
	let trashByAccount = $state(new Map());
	let loading = $state(false);
	let error = $state('');
	/** @type {Set<string>} ids currently being restored */
	let restoring = $state(new Set());

	async function loadAll() {
		if (!session.accounts.length) {
			trashByAccount = new Map();
			return;
		}
		loading = true;
		error = '';
		try {
			const entries = await Promise.all(
				session.accounts.map(async (a) => {
					try {
						const rows = await fetchTrashForAccount(a.id);
						return /** @type {[string, import('$lib/api/trash').TrashedEntity[]]} */ ([a.id, rows]);
					} catch {
						return /** @type {[string, import('$lib/api/trash').TrashedEntity[]]} */ ([a.id, []]);
					}
				})
			);
			trashByAccount = new Map(entries);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		loading = false;
	}

	async function reloadOne(/** @type {string} */ accountId) {
		try {
			const rows = await fetchTrashForAccount(accountId);
			const next = new Map(trashByAccount);
			next.set(accountId, rows);
			trashByAccount = next;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	/**
	 * Trigger the actual restore. Opens a one-shot Replicache client at
	 * the entity's id, dispatches `unarchiveList`, force-pushes so the
	 * server's `unarchiveEntity` runs and the catalog's `time_deleted`
	 * clears before we refetch, then closes the client to release IDB.
	 * @param {string} accountId
	 * @param {import('$lib/api/trash').TrashedEntity} entity
	 */
	async function restore(accountId, entity) {
		if (restoring.has(entity.id)) return;
		const nextSet = new Set(restoring);
		nextSet.add(entity.id);
		restoring = nextSet;
		error = '';
		try {
			const rep = initList({
				accountId,
				listId: entity.id,
				skipClientInit: true
			});
			try {
				await rep.mutate.unarchiveList({ listId: entity.id });
				await rep.client.push?.();
			} finally {
				await rep.client.close();
			}
			await reloadOne(accountId);
			if (entity.type === 'workspace') {
				// Workspace's reappearance in the switcher comes from
				// session.workspaces. Cascade-restore drains async in
				// the background; the children's restored rows will
				// show up the next time their respective routes pull.
				await session.refreshWorkspaces();
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			const cleared = new Set(restoring);
			cleared.delete(entity.id);
			restoring = cleared;
		}
	}

	$effect(() => {
		if (session.hasLoaded) {
			void loadAll();
		}
	});

	/**
	 * Render time_deleted (unix seconds) as a coarse relative string.
	 * Not localized; the Trash is owner-only and rarely visited, so a
	 * blunt "3 hours ago" is fine for v1.
	 * @param {number} seconds
	 */
	function whenDeleted(seconds) {
		const ms = seconds * 1000;
		const diff = Date.now() - ms;
		if (diff < 60_000) return 'moments ago';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}

	function displayName(/** @type {import('$lib/api/trash').TrashedEntity} */ e) {
		return e.name && e.name.trim() ? e.name : `(unnamed ${e.type})`;
	}

	function accountLabel(/** @type {{ id: string, display_name?: string|null }} */ a) {
		return a.display_name?.trim() || a.id;
	}

	const totalCount = $derived(
		Array.from(trashByAccount.values()).reduce((n, rs) => n + rs.length, 0)
	);
</script>

<h1 class="text-2xl mb-2">Trash</h1>

{#if !session.accounts.length}
	<p>Sign in to manage your trash.</p>
{:else if loading && !trashByAccount.size}
	<p class="text-sm text-stone-500">Loading…</p>
{:else if totalCount === 0}
	<p>
		<i>Nothing in the trash.</i>
	</p>
	<p class="text-sm text-stone-500 mt-2">
		Soft-deleted workspaces, lists, and templates land here and stay restorable
		for 30 days. After that they're permanently deleted.
	</p>
{:else}
	<p class="text-sm text-stone-500 mb-4">
		Soft-deleted items stay restorable for 30 days before they're permanently
		deleted. Restoring a workspace also restores any lists and templates that
		were cascade-deleted with it.
	</p>
	{#each session.accounts as account (account.id)}
		{@const rows = trashByAccount.get(account.id) ?? []}
		{#if rows.length}
			<section class="mb-6">
				{#if session.accounts.length > 1}
					<h2 class="text-sm uppercase tracking-wide text-stone-500 mb-2">
						{accountLabel(account)}
					</h2>
				{/if}
				<ul>
					{#each rows as e (e.id)}
						<li class="my-2 flex items-center gap-3">
							<span class="flex-1">
								<span class="font-medium">{displayName(e)}</span>
								<span class="text-xs text-stone-500 ml-2">
									{e.type} · deleted {whenDeleted(e.time_deleted)}
								</span>
							</span>
							<button
								class="border px-3 py-1 text-sm"
								onclick={() => restore(account.id, e)}
								disabled={restoring.has(e.id)}
							>
								{restoring.has(e.id) ? 'Restoring…' : 'Restore'}
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/each}
{/if}

{#if error}
	<p class="text-red-600 text-sm mt-4">{error}</p>
{/if}
