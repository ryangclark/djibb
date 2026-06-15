<!--
  Homepage — the "out" funnel (CONTEXT.md §Minted List). Reads the global
  Seed Pool List (a real DO, bootstrapped by `djibb promote`), picks one of
  its referenced Blank Templates, and renders an engageable preview:

    • first visit  → the latest Blank (last appended to the pool)
    • return/refresh → a random Blank

  Mint-on-engage (Phase 4a): the preview's checkboxes are live. The first
  toggle forks the Blank into a brand-new ownerless List (copying its
  content with fresh ids via `mintFromBlank`), applies that toggle, drops a
  sticky localStorage pointer (so a later sign-in can Adopt it — Phase 4b),
  and navigates to `/l/<id>` where the full editor takes over.

  Reads (pool + Blank) go through the existing Replicache machinery with
  `skipClientInit: true` — never optimistically *create* those. The mint, by
  contrast, deliberately creates: it opens a client at the new list id and
  fires `mintFromBlank`. The same code runs locally and in prod once the
  pool is promoted there.
-->
<script>
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';

	import { initList } from '$lib/replicache/index.svelte.js';
	import { getSessionState } from '$lib/session.svelte';
	import { SEED_POOL_LIST_ID } from '$djibb/list';
	import { IdTypes, newId } from '$djibb/id';
	import BlankPreview from '$lib/components/BlankPreview.svelte';

	/**
	 * @typedef {import('$djibb/list').ListItem} ListItem
	 */

	const sessionState = getSessionState();

	/** First-visit vs return is remembered here; absent ⇒ first visit. */
	const SEEN_KEY = 'djibb:homepage_seen';
	/** Sticky pointers to ownerless lists this browser minted (Phase 4b). */
	const MINTED_KEY = 'djibb:minted_pending';

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

	// --- mint-on-engage -----------------------------------------------------

	/** Guard against a double-fire while the first mint is in flight. */
	let minting = false;
	/** Kept so we can close the mint client when this page unmounts. */
	/** @type {ReturnType<typeof initList> | null} */
	let mintClient = null;

	/**
	 * Fork the chosen Blank into a fresh List. Allocates a new list id and
	 * remaps every group/item to a fresh id (parents + child_element_refs
	 * remapped to match), so the optimistic and authoritative writes share
	 * ids (a Replicache requirement) and the content stays an id-independent
	 * faithful copy (what the DO fork-verify preflight checks).
	 *
	 * @param {string} blankId
	 * @param {import('$djibb/list').Template} src
	 * @param {{ [id: string]: import('replicache').ReadonlyJSONValue }} map
	 */
	function buildMintPlan(blankId, src, map) {
		const listId = newId('list');
		/** @type {Record<string, string>} The blank itself maps to the new list. */
		const idMap = { [blankId]: listId };
		/** @type {string[]} Descendant ids in pre-order. */
		const ordered = [];

		/** @param {string[]} refs */
		const allocate = (refs) => {
			for (const r of refs) {
				/** @type {any} */
				const row = map[r];
				if (!row) continue;
				ordered.push(r);
				if (r.startsWith(`${IdTypes.group}/`)) {
					idMap[r] = newId('group');
					allocate(row.child_element_refs ?? []);
				} else if (r.startsWith(`${IdTypes.item}/`)) {
					idMap[r] = newId('item');
				}
			}
		};
		allocate(src.child_element_refs ?? []);

		/** @param {string[]} refs */
		const remap = (refs) => refs.map((r) => idMap[r]).filter(Boolean);

		/** @type {any[]} */ const groups = [];
		/** @type {any[]} */ const items = [];
		for (const oldId of ordered) {
			/** @type {any} */
			const row = map[oldId];
			if (oldId.startsWith(`${IdTypes.group}/`)) {
				groups.push({
					...row,
					id: idMap[oldId],
					parent_element_ref: idMap[row.parent_element_ref] ?? listId,
					child_element_refs: remap(row.child_element_refs ?? [])
				});
			} else if (oldId.startsWith(`${IdTypes.item}/`)) {
				items.push({
					...row,
					id: idMap[oldId],
					parent_element_ref: idMap[row.parent_element_ref] ?? listId
				});
			}
		}

		return {
			listId,
			name: src.name,
			description: src.description,
			childElementRefs: remap(src.child_element_refs ?? []),
			groups,
			items,
			idMap
		};
	}

	/**
	 * The first-edit gesture: mint the List, apply this toggle to the
	 * minted copy of the toggled item, remember it, and navigate.
	 *
	 * @param {ListItem} item The toggled Blank item (old ids).
	 * @param {boolean} checked Its new checked state.
	 */
	async function handleEngage(item, checked) {
		if (minting || !blank || !chosenBlankId) return;
		minting = true;

		const plan = buildMintPlan(chosenBlankId, blank, blankData);

		// Open a client at the NEW list id and create it. skipClientInit so
		// the empty store doesn't fire the optimistic initList shortcut — we
		// mint explicitly instead.
		const rc = initList({
			accountId: sessionState.currentAccountId,
			listId: plan.listId,
			workspaceId: sessionState.currentWorkspaceId,
			skipClientInit: true
		});
		mintClient = rc;

		await rc.mutate.mintFromBlank({
			listId: plan.listId,
			workspaceId: sessionState.currentWorkspaceId,
			blankId: chosenBlankId,
			name: plan.name,
			description: plan.description,
			childElementRefs: plan.childElementRefs,
			groups: plan.groups,
			items: plan.items
		});

		// Apply the toggle to the minted copy of the clicked item.
		const newItemId = plan.idMap[item.id];
		if (newItemId) {
			const value = item.value;
			const newValue = checked ? value.target_value : (value.min_value ?? 0);
			await rc.mutate.setItemQuantity({
				itemId: newItemId,
				quantity: { ...value, value: newValue }
			});
		}

		rememberMinted(plan.listId);

		const suffix = plan.listId.split('/', 2)[1] ?? '';
		await goto(`/l/${suffix}`);
	}

	/** @param {string} listId */
	function rememberMinted(listId) {
		try {
			const raw = localStorage.getItem(MINTED_KEY);
			/** @type {string[]} */
			const arr = raw ? JSON.parse(raw) : [];
			if (!arr.includes(listId)) arr.push(listId);
			localStorage.setItem(MINTED_KEY, JSON.stringify(arr));
		} catch {
			// localStorage unavailable (private mode etc.) — the mint still
			// works; only the later Adopt-on-sign-in convenience is lost.
		}
	}

	// The mint persists to IndexedDB before we navigate, so the list route's
	// same-named client resumes the push even after this one closes.
	onDestroy(() => mintClient?.client.close());
</script>

{#if blank}
	<BlankPreview {blank} data={blankData} onEngage={handleEngage} />
{:else if pool && candidates.length === 0}
	<h1>djibb</h1>
	<p class="ml-8">Building beautiful, remixable checklists.</p>
{:else}
	<p class="text-slate-500">Loading…</p>
{/if}
