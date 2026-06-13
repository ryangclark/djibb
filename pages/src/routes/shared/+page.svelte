<script>
	// @ts-check
	/**
	 * ADR 0009 §"Shared with me" — the recipient's surface for entities
	 * granted to them directly (a list/template someone shared), the way
	 * back to "Weekend BBQ" after accepting an invite. Read-only listing;
	 * each row links to the entity. v1 D1 index (the end-state DjibbList
	 * substrate is ADR 0013's deferred question).
	 */
	import { getSessionState } from '$lib/session.svelte';
	import { fetchSharedForAccount } from '$lib/api/shared';

	const session = getSessionState();

	/** @type {Map<string, import('$lib/api/shared').SharedEntity[]>} */
	let sharedByAccount = $state(new Map());
	let loading = $state(false);
	let error = $state('');

	async function loadAll() {
		if (!session.accounts.length) {
			sharedByAccount = new Map();
			return;
		}
		loading = true;
		error = '';
		try {
			const entries = await Promise.all(
				session.accounts.map(async (a) => {
					try {
						const rows = await fetchSharedForAccount(a.id);
						return /** @type {[string, import('$lib/api/shared').SharedEntity[]]} */ ([
							a.id,
							rows
						]);
					} catch {
						return /** @type {[string, import('$lib/api/shared').SharedEntity[]]} */ ([
							a.id,
							[]
						]);
					}
				})
			);
			sharedByAccount = new Map(entries);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		loading = false;
	}

	$effect(() => {
		if (session.hasLoaded) {
			void loadAll();
		}
	});

	/** @param {import('$lib/api/shared').SharedEntity} e */
	function entityHref(e) {
		const prefix = e.type === 'template' ? 't' : 'l';
		return `/${prefix}/${e.id}`;
	}

	/** @param {import('$lib/api/shared').SharedEntity} e */
	function displayName(e) {
		return e.name && e.name.trim() ? e.name : `(unnamed ${e.type})`;
	}

	/** @param {{ id: string, display_name?: string|null }} a */
	function accountLabel(a) {
		return a.display_name?.trim() || a.id;
	}

	const totalCount = $derived(
		Array.from(sharedByAccount.values()).reduce((n, rs) => n + rs.length, 0)
	);
</script>

<h1 class="text-2xl mb-2">Shared with me</h1>

{#if !session.accounts.length}
	<p>Sign in to see what's been shared with you.</p>
{:else if loading && !sharedByAccount.size}
	<p class="text-sm text-stone-500">Loading…</p>
{:else if totalCount === 0}
	<p><i>Nothing shared with you yet.</i></p>
	<p class="text-sm text-stone-500 mt-2">
		Lists and templates that others share with you directly show up here.
	</p>
{:else}
	<p class="text-sm text-stone-500 mb-4">
		Lists and templates shared with you directly.
	</p>
	{#each session.accounts as account (account.id)}
		{@const rows = sharedByAccount.get(account.id) ?? []}
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
								<a class="font-medium underline" href={entityHref(e)}>
									{displayName(e)}
								</a>
								<span class="text-xs text-stone-500 ml-2">
									{e.type} · {e.role}
								</span>
							</span>
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
