<!--
  Homepage — the "out" funnel (CONTEXT.md §Minted List). Reads the global
  Seed Pool List (a real DO, bootstrapped by `djibb promote`), picks one of
  its referenced Blank Templates, and renders a read-only preview:

    • first visit  → the latest Blank (last appended to the pool)
    • return/refresh → a random Blank

  Both the pool and the chosen Blank are pulled read-only via the existing
  Replicache machinery with `skipClientInit: true` — the homepage must
  never optimistically *create* these entities, only read them. This is the
  same code locally (6 Blanks already promoted into `.wrangler`) and in prod
  once we `djibb promote --base https://djibb.com`; no code change needed.

  An empty pool (e.g. prod before the first promote) falls back to the
  tagline, so the page is always functional.
-->
<script>
	import { initList } from '$lib/replicache/index.svelte.js';
	import { getSessionState } from '$lib/session.svelte';
	import { SEED_POOL_LIST_ID } from '$djibb/list';
	import { IdTypes } from '$djibb/id';
	import BlankPreview from '$lib/components/BlankPreview.svelte';

	const sessionState = getSessionState();

	/** First-visit vs return is remembered here; absent ⇒ first visit. */
	const SEEN_KEY = 'djibb:homepage_seen';

	/** @type {{ [id: string]: import('replicache').ReadonlyJSONValue }} */
	let poolData = $state({});

	/** @type {import('$djibb/list').List | undefined} */
	// @ts-ignore — Replicache returns ReadonlyJSONValue; shape is a List.
	let pool = $derived(poolData[SEED_POOL_LIST_ID]);

	// Blank Template ids referenced by the pool's items, in pool order
	// (promote appends, so the order is chronological — last is newest).
	let candidates = $derived.by(() => {
		if (!pool) return /** @type {string[]} */ ([]);
		/** @type {string[]} */
		const ids = [];
		for (const ref of pool.child_element_refs) {
			/** @type {any} */
			const row = poolData[ref];
			const target = row?.references_entity_id;
			if (typeof target === 'string' && target.startsWith(`${IdTypes.template}/`)) {
				ids.push(target);
			}
		}
		return ids;
	});

	/** @type {string | null} */
	let chosenBlankId = $state(null);

	// Choose exactly once, the first time candidates are available. Kept
	// as state (not derived) because selection has side effects (reads +
	// writes localStorage, rolls a random) and must be stable across the
	// later pulls/refreshes within a single page view.
	$effect(() => {
		if (chosenBlankId || candidates.length === 0) return;
		const seen = localStorage.getItem(SEEN_KEY);
		const idx = seen
			? Math.floor(Math.random() * candidates.length)
			: candidates.length - 1;
		localStorage.setItem(SEEN_KEY, '1');
		chosenBlankId = candidates[idx] ?? null;
	});

	/** @type {{ [id: string]: import('replicache').ReadonlyJSONValue }} */
	let blankData = $state({});

	/** @type {import('$djibb/list').Template | undefined} */
	// @ts-ignore — Replicache returns ReadonlyJSONValue; shape is a Template.
	let blank = $derived(chosenBlankId ? blankData[chosenBlankId] : undefined);

	// Pull the Seed Pool (read-only — never fire the optimistic initList).
	$effect(() => {
		// Gate on session load: pulling as the wrong actor (null before the
		// account resolves) would resolve auth against the anonymous role.
		// See /l/[id]/+page.svelte for the long-form rationale.
		if (!sessionState.hasLoaded) return;
		const rc = initList({
			accountId: sessionState.currentAccountId,
			listId: SEED_POOL_LIST_ID,
			skipClientInit: true
		});
		poolData = rc.list;
		return () => rc.client.close();
	});

	// Pull the chosen Blank once selection lands (read-only).
	$effect(() => {
		if (!sessionState.hasLoaded || !chosenBlankId) return;
		const rc = initList({
			accountId: sessionState.currentAccountId,
			listId: chosenBlankId,
			skipClientInit: true
		});
		blankData = rc.list;
		return () => rc.client.close();
	});
</script>

{#if blank}
	<BlankPreview {blank} data={blankData} />
{:else if pool && candidates.length === 0}
	<h1>djibb</h1>
	<p class="ml-8">Building beautiful, remixable checklists.</p>
{:else}
	<p class="text-slate-500">Loading…</p>
{/if}
