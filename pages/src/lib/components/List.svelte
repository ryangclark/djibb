<script>
	import { LIST_ELEMENT_TYPES } from '$djibb/list/constants';

	/**
	 * @typedef Props
	 * @property {*} data List data
	 * @property {import('$djibb/list').List} list
	 * @property {import('$lib/replicache/types').ClientListMutators} mutators
	 */

	/** @type {Props} */
	let { data, list, mutators } = $props();

	/**
	 * @param {Event} event
	 */
	function handleCheckboxInput(event) {
		// This keeps typescript happy.
		if (!(event.target instanceof HTMLInputElement)) {
			throw new Error(
				`\`handleCheckboxInput()\` error: unexpected \`event.target\` ${event.target}`
			);
		}

		const elem_id = event.target.getAttribute('data-elem-id');

		if (!elem_id) {
			throw new Error('invalid `elem_id`!');
		}

		// NOTE: hard-coded the element type to `item` for now.
		const elemData = data[`item/${elem_id}`];

		let newValue;
		if (event.target.checked) {
			newValue = elemData.quantity.target_value;
		} else {
			newValue = elemData.quantity.min_value ?? 0;
		}

		mutators.setItemQuantity({
			authorizedRole: 'ownerless', // TODO: hook this up to real stuff.
			itemId: elem_id,
			quantity: {
				...elemData.quantity,
				value: newValue
			}
		});
	}
</script>

{#if data}
	<article data-elem-id={list.id} data-elem-type={list.type}>
		<h2 class="text-xl">{list.title}</h2>

		<p>Created: {new Date(list.time_created).toLocaleDateString()}</p>
		<p>Updated: {new Date(list.time_updated).toLocaleDateString()}</p>

		{#if list.description}
			<p class="my-2">{list.description}</p>
		{/if}

		{#if list?.child_element_refs?.length}
			{#each list.child_element_refs as child_ref}
				{@render child(child_ref)}
			{/each}
		{:else}
			<p>NO ITEMS! Pls implement an empty state.</p>
		{/if}
	</article>
{:else}
	<p>Loading data!</p>
{/if}

{#snippet child(child_ref)}
	{@const child = data[child_ref]}
	{#if child}
		{#if child.type === LIST_ELEMENT_TYPES.GROUP}
			{@render group(child)}
		{:else if child.type === LIST_ELEMENT_TYPES.ITEM}
			{@render item(child)}
		{:else}
			<p>UNSUPPORTED LIST ELEMENT TYPE: "{child.type}"</p>
		{/if}
	{:else}
		<p>Element not found: "{child_ref}"</p>
	{/if}
{/snippet}

{#snippet group(elem)}
	<section class="my-8" data-elem-id={elem.id} data-elem-type={elem.type}>
		<h3 class="text-xl">{elem.title}</h3>
		{#if elem?.child_element_refs?.length}
			<div class="flex flex-col">
				{#each elem.child_element_refs as child_ref}
					{@render child(child_ref)}
				{/each}
			</div>
		{:else}
			<p>Group has no child elements!</p>
		{/if}
	</section>
{/snippet}

{#snippet item(elem)}
	<label>
		<input
			data-elem-id={elem.id}
			data-elem-type={elem.type}
			oninput={handleCheckboxInput}
			name={elem.title}
			type="checkbox"
			checked={elem.quantity.value === elem.quantity.target_value}
		/>
		{elem.title}
	</label>
{/snippet}
