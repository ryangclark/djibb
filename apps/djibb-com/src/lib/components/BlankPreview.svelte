<!--
  Preview of a Blank Template, used by the homepage to render the rotating
  Seed Pool selection (CONTEXT.md §Minted List).

  Deliberately NOT the full `List.svelte` editor: no cursor, no add/delete,
  no text editing. It walks the same data shape the editor consumes — a flat
  map keyed by element id, traversed via each element's `child_element_refs`.

  Two modes, by whether `onEngage` is passed:
    • read-only (no `onEngage`)  — checkboxes are inert; a link offers the
      full template view. Used anywhere a static preview is wanted.
    • engageable (`onEngage` set) — checkboxes are live; toggling one is the
      homepage's "first edit fires a mint" gesture (Phase 4a). The parent
      mints a real List from this Blank and navigates there; this component
      stays dumb and just reports the toggle.
-->
<script>
	import { IdTypes } from '@djibb/protocol/id';

	/**
	 * @typedef {import('@djibb/protocol/list').Template} Template
	 * @typedef {import('@djibb/protocol/list').ListGroup} ListGroup
	 * @typedef {import('@djibb/protocol/list').ListItem} ListItem
	 */

	let {
		/** @type {Template} */
		blank,
		/** @type {{ [id: string]: import('replicache').ReadonlyJSONValue }} */
		data,
		/**
		 * First-edit hook. When provided, checkboxes are interactive and a
		 * toggle calls this with the toggled item and its new checked state.
		 * Absent ⇒ read-only preview.
		 * @type {((item: ListItem, checked: boolean) => void) | undefined}
		 */
		onEngage = undefined
	} = $props();

	/** Suffix-only id for the `/t/<id>` route (strips the `t/` prefix). */
	let blankSuffix = $derived(blank.id.split('/', 2)[1] ?? '');
</script>

<article class="max-w-2xl">
	<header class="mb-4">
		<p class="text-sm uppercase tracking-wide text-slate-500">From the Seed Pool</p>
		<h1 class="text-3xl font-semibold">{blank.name}</h1>
		{#if blank.description}
			<p class="mt-2 text-slate-700">{blank.description}</p>
		{/if}
	</header>

	<div class="flex flex-col gap-1">
		{#each blank.child_element_refs as ref (ref)}
			{@render element(ref)}
		{:else}
			<p class="text-slate-500 italic">This list is empty.</p>
		{/each}
	</div>

	<footer class="mt-6">
		{#if onEngage}
			<p class="text-sm text-slate-500">Check anything to make it your own copy.</p>
		{:else}
			<a
				class="inline-block border border-slate-700 px-4 py-2 hover:bg-slate-100"
				href="/t/{blankSuffix}"
			>
				Remix this list
			</a>
		{/if}
	</footer>
</article>

<!-- Dispatch on element type, looking the row up in the flat data map.
     A ref can dangle transiently (parent updated before child pulled);
     render nothing rather than crash, mirroring the editor. -->
{#snippet element(/** @type {string} */ ref)}
	{@const row = data[ref]}
	{#if row}
		{#if ref.startsWith(`${IdTypes.group}/`)}
			{@render group(/** @type {ListGroup} */ (/** @type {unknown} */ (row)))}
		{:else if ref.startsWith(`${IdTypes.item}/`)}
			{@render item(/** @type {ListItem} */ (/** @type {unknown} */ (row)))}
		{/if}
	{/if}
{/snippet}

{#snippet group(/** @type {ListGroup} */ g)}
	<section class="mt-3">
		<h2 class="text-lg font-medium">{g.name}</h2>
		<div class="flex flex-col gap-1 pl-4">
			{#each g.child_element_refs as childRef (childRef)}
				{@render element(childRef)}
			{/each}
		</div>
	</section>
{/snippet}

{#snippet item(/** @type {ListItem} */ i)}
	<label class="flex items-center gap-2 text-slate-800">
		<input
			type="checkbox"
			disabled={!onEngage}
			checked={i.value.value === i.value.target_value}
			onchange={(e) => onEngage?.(i, e.currentTarget.checked)}
		/>
		<span>{i.name}</span>
	</label>
{/snippet}
