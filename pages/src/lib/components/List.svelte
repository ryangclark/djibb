<script>
	import { tick } from 'svelte';

	import IconPlus from '@tabler/icons-svelte/icons/plus';

	import { LIST_ELEMENT_TYPES } from '$djibb/list/constants';

	import { ListItemSchema, ListSchema } from '$djibb/list/index';
	import { z } from 'zod';
	import { newId } from '$djibb/id';
	import { tryCatch, tryCatchAsync } from '$djibb/utils/trycatch';
	import { getSessionState } from '$lib/session.svelte.js';

	/**
	 * @typedef Props
	 * @property {*} data List data
	 * @property {import('$djibb/list').List} list
	 * @property {import('$lib/replicache/types').ClientListMutators} mutators
	 */

	/** @type {Props} */
	let { data, list: rawList, mutators } = $props();
	/** @type {import('$djibb/list').List} */
	let list = $derived.by(() => {
		if (typeof rawList === 'string') {
			const result = tryCatch(() => JSON.parse(rawList));
			if (result.error) {
				throw new Error(`invalid list JSON: ${result.error.message}`);
			}

			return ListSchema.parse(result.data);
		}

		return ListSchema.parse(rawList);
	});

	const sessionState = getSessionState();

	let show_quick_add_item_form = $state(false);
	let editing_name = $state(false);
	let name_draft = $state('');

	// Bindings
	/** @type {HTMLInputElement} */
	let quick_add_list_item_input;
	/** @type {HTMLInputElement} */
	let edit_name_input;

	function startEditName() {
		name_draft = list.name ?? '';
		editing_name = true;
		tick().then(() => edit_name_input?.select());
	}

	async function commitEditName() {
		const trimmed = name_draft.trim();
		if (!trimmed || trimmed === list.name) {
			editing_name = false;
			return;
		}
		const result = await tryCatchAsync(
			mutators.renameList({
				accountId: sessionState.currentAccountId,
				listId: list.id,
				name: trimmed,
				timestamp_client: new Date()
			})
		);
		if (result.error) {
			console.error('renameList mutation error:', result.error);
			alert(`Failed to rename list: ${result.error?.message ?? result.error}`);
			return;
		}
		editing_name = false;
	}

	function cancelEditName() {
		editing_name = false;
	}

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

		// Element IDs stored in Replicache are already prefixed (e.g. `i/abc…`).
		const elemData = data[elem_id];

		if (!elemData || !elemData.value) {
			console.error(
				'`handleCheckboxInput()` missing elemData or elemData.value for',
				elem_id
			);
			return;
		}

		let newValue;
		if (event.target.checked) {
			newValue = elemData.value.target_value;
		} else {
			newValue = elemData.value.min_value ?? 0;
		}

		if (!mutators) {
			console.error('`handleCheckboxInput()` mutators not ready');
			return;
		}

		mutators.setItemQuantity({
			accountId: sessionState.currentAccountId,
			itemId: elem_id,
			quantity: { ...elemData.value, value: newValue },
			timestamp_client: new Date()
		});
	}

	/**
	 * @param {Event} event
	 */
	async function handleQuickAddSubmit(event) {
		event.preventDefault();

		if (!(event.target instanceof HTMLFormElement)) {
			return;
		}

		const formData = new FormData(event.target);
		const name = formData.get('name');

		if (!name) {
			alert('bad name!');
			return;
		}
		if (!list?.id) {
			// TODO: improve error handling here...?
			alert('no list!');
			return;
		}

		const now = new Date();
		/** @type {import("$djibb/list/index").ListItem} */
		const listItem = {
			id: newId('item'),
			name: name.toString(),
			parent_element_ref: list.id, // use the List as the parent for now
			references_entity_id: null,
			time_created: now,
			time_deleted: null,
			time_updated: now,
			type: 'item',
			value: { target_value: 1, value: 0, unit: 'bool' },
			version: 0
		};

		// Validate inputs via zod if we're not in prod.
		if (import.meta.env.MODE !== 'production') {
			const parseResult = ListItemSchema.safeParse(listItem);

			if (!parseResult.success) {
				alert(`Failed:\n${z.prettifyError(parseResult.error)}`);
				return;
			}
		}

		const { error } = await tryCatchAsync(
			mutators.createListItem({
				accountId: sessionState.currentAccountId,
				item: listItem,
				timestamp_client: now
			})
		);

		if (error) {
			// TODO: improve error handling
			console.error(
				'`handle_quick_add_list_item_submit()` mutation error:',
				error
			);
			alert(`Failed to add item: ${error?.message ?? error}`);
			return;
		}

		event.target.reset();
		quick_add_list_item_input?.focus();
	}
</script>

{#if data && rawList}
	{#if list.workspace_id}
		<!-- TODO: -->
		<!-- Implement a "workspace kicker" - need to get the workspace name,etc. -->
		<p class="text-slate-700 text-sm my-2">Workspace ID: {list.workspace_id}</p>
	{/if}

	<article data-elem-id={list.id} data-elem-type={list.type}>
		<header class="flex gap-2 my-3 items-baseline">
			{#if editing_name}
				<input
					bind:this={edit_name_input}
					bind:value={name_draft}
					class="text-2xl border-b border-slate-400 outline-none flex-1"
					onblur={commitEditName}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							commitEditName();
						} else if (e.key === 'Escape') {
							e.preventDefault();
							cancelEditName();
						}
					}}
				/>
			{:else}
				<h2
					class="text-2xl cursor-text"
					onclick={startEditName}
					onkeydown={(e) => {
						if (e.key === 'Enter') startEditName();
					}}
					role="button"
					tabindex="0"
				>
					{#if list.name}
						{list.name}
					{:else}
						<span class="italic text-slate-500">Untitled List</span>
					{/if}
				</h2>
			{/if}
		</header>

		<!-- TODO: hydrate these dates elsewhere -->
		<div class="flex gap-2 text-slate-700">
			<p>Created: {new Date(list.time_created).toLocaleDateString()}</p>
			<p>•</p>
			<p>Updated: {new Date(list.time_updated).toLocaleDateString()}</p>
		</div>

		{@render list_description(list.description)}

		<!-- <hr class="my-2" /> -->
		{@render list_toolbar()}

		{#each list.child_element_refs as child_ref}
			{@render child(child_ref)}
		{:else}
			{@render empty_list()}
		{/each}

		{#if show_quick_add_item_form}
			{@render quick_add_list_item()}
		{:else}
			<button
				class="flex cursor-pointer border my-2 py-0.5 px-2"
				onclick={() => {
					show_quick_add_item_form = true;
					tick().then(() => {
						quick_add_list_item_input?.focus();
					});
				}}
			>
				<IconPlus stroke={1.5} />
				<span>Add Item</span>
			</button>
		{/if}
	</article>
{:else}
	<p>Loading data!</p>
{/if}

{#snippet quick_add_list_item()}
	<form class="my-2" onsubmit={handleQuickAddSubmit}>
		<!-- <label for="quick_add_list_item-name"></label> -->
		<input
			bind:this={quick_add_list_item_input}
			class="border p-1 pl-2"
			id="quick_add_list_item-name"
			name="name"
			placeholder="new item"
		/>
	</form>
{/snippet}

{#snippet empty_list()}
	<div>
		<p class="italic">No items</p>
	</div>
{/snippet}

{#snippet child(/** @type {string} */ child_ref)}
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

{#snippet group(
	/** @type {import("$djibb/list/index.ts").ListGroup} */
	elem
)}
	<section class="my-8" data-elem-id={elem.id} data-elem-type={elem.type}>
		<h3 class="text-xl">{elem.name}</h3>
		<div class="flex flex-col">
			{#each elem.child_element_refs as child_ref}
				{@render child(child_ref)}
			{:else}
				<p>Group has no child elements!</p>
			{/each}
		</div>
	</section>
{/snippet}

{#snippet item(
	/** @type {import("$djibb/list/index.ts").ListItem} */
	elem
)}
	<label>
		<input
			data-elem-id={elem.id}
			data-elem-type={elem.type}
			oninput={handleCheckboxInput}
			name={elem.name}
			type="checkbox"
			checked={elem.value.value === elem.value.target_value}
		/>
		{elem.name}
	</label>
{/snippet}

{#snippet list_description(
	/** @type {import("$djibb/list/index.ts").ListElement['description']} */
	description
)}
	{#if list.description}
		<p class="my-2">{description}</p>
		<!-- TODO: -->
		<!-- Need a "Add description" button if none -->
		<!-- Need an "Edit" button if description -->
	{/if}
{/snippet}

{#snippet list_toolbar()}
	<div class="my-2 border border-slate-700 bg-slate-100 p-1">
		[Remix This List] [Share] [Export] [Print] [Add Item or Group]
	</div>
{/snippet}
