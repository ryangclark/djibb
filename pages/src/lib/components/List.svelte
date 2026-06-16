<script>
	import { tick } from 'svelte';

	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconLink from '@tabler/icons-svelte/icons/link';
	import IconX from '@tabler/icons-svelte/icons/x';

	import { LIST_ELEMENT_TYPES } from '$djibb/list/constants';

	import { ListItemSchema, ListSchema, TemplateSchema } from '$djibb/list/index';
	import { IdTypes } from '@djibb/protocol/id';
	import { z } from 'zod';
	import { newId } from '@djibb/protocol/id';
	import { tryCatch, tryCatchAsync } from '$djibb/utils/trycatch';
	import { fetchOwnedEntities } from '$lib/entities.js';
	import { getSessionState } from '$lib/session.svelte.js';
	import { createListViewVerbs } from '$lib/keymap/listViewVerbs.svelte.js';
	import { buildKeymapRegistry } from '$lib/keymap/registry.js';
	import { goto } from '$app/navigation';
	import EditPanel from '$lib/components/EditPanel.svelte';
	import CheatsheetOverlay from '$lib/components/CheatsheetOverlay.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';

	/**
	 * @typedef Props
	 * @property {*} data List data
	 * @property {import('$djibb/list').List} list
	 * @property {import('$lib/replicache/types').ClientListMutators} mutators
	 * @property {import('$lib/replicache/types').ClientListMutators} mutateWithUndo
	 *   User-firing path that pushes stack entries. The list-view
	 *   verbs (Cmd+Backspace, Space, +/−) call this so undo restores
	 *   them; system / native-input handlers stay on `mutators`.
	 * @property {{
	 *   undo: () => Promise<boolean>,
	 *   redo: () => Promise<boolean>,
	 * }} undoRuntime
	 *   Used by the command palette so ⌘Z / ⌘⇧Z are first-class
	 *   palette commands (alongside the global keymap bindings).
	 */

	/** @type {Props} */
	let { data, list: rawList, mutators, mutateWithUndo, undoRuntime } = $props();

	// Accept either entity type — this component renders both lists and
	// templates using the same DO machinery; the only branch points are
	// the type literal and the ID prefix.
	const EntitySchema = z.discriminatedUnion('type', [ListSchema, TemplateSchema]);

	/** @type {import('$djibb/list').List | import('$djibb/list').Template} */
	let list = $derived.by(() => {
		if (typeof rawList === 'string') {
			const result = tryCatch(() => JSON.parse(rawList));
			if (result.error) {
				throw new Error(`invalid list JSON: ${result.error.message}`);
			}

			return EntitySchema.parse(result.data);
		}

		return EntitySchema.parse(rawList);
	});

	const sessionState = getSessionState();

	let show_quick_add_item_form = $state(false);
	let editing_name = $state(false);
	let name_draft = $state('');

	/**
	 * Item ID currently showing the reference picker, or null if no
	 * picker is open. Only one picker open at a time keeps the UI calm.
	 *
	 * @type {string | null}
	 */
	let picker_open_for = $state(null);
	let picker_query = $state('');
	/** @type {{ id: string, type: 'list' | 'template', name: string | null }[]} */
	let picker_entities = $state([]);
	let picker_loading = $state(false);

	/** Filtered + self-excluded view of `picker_entities`. */
	let picker_filtered = $derived.by(() => {
		const q = picker_query.trim().toLowerCase();
		return picker_entities
			.filter((e) => e.id !== list.id) // can't reference the current list
			.filter((e) => {
				if (!q) return true;
				return (e.name ?? '').toLowerCase().includes(q);
			});
	});

	async function openPicker(/** @type {string} */ itemId) {
		picker_open_for = itemId;
		picker_query = '';
		// Focus the search field once the picker row has mounted — the
		// intended open-gesture UX, without an `autofocus` attribute.
		tick().then(() => picker_search_input?.focus());
		if (picker_entities.length === 0) {
			picker_loading = true;
			const result = await tryCatchAsync(
				fetchOwnedEntities({ accountId: sessionState.currentAccountId })
			);
			picker_loading = false;
			if (result.error) {
				console.error('fetchOwnedEntities error:', result.error);
				alert(`Failed to load entities: ${result.error.message}`);
				picker_open_for = null;
				return;
			}
			picker_entities = result.data ?? [];
		}
	}

	function closePicker() {
		picker_open_for = null;
		picker_query = '';
	}

	/**
	 * @param {import('$djibb/list').ListItem} item
	 * @param {string | null} entityId Pass null to clear the reference.
	 */
	async function pickReference(item, entityId) {
		const result = await tryCatchAsync(
			mutators.setItemFields({
				id: item.id,
				fields: { references_entity_id: entityId }
			})
		);
		if (result.error) {
			console.error('setItemFields (reference) error:', result.error);
			alert(`Failed to set reference: ${result.error.message}`);
			return;
		}
		closePicker();
	}

	/**
	 * Maps an entity ID to the page route that renders it. Mirrors the
	 * worker-side mapping in lib/replicache and lib/websocket.
	 *
	 * @param {string} id
	 */
	function entityHref(id) {
		const type = id.startsWith(`${IdTypes.template}/`) ? 't' : 'l';
		const suffix = id.split('/', 2)[1] ?? '';
		return `/${type}/${suffix}`;
	}

	/** @param {string} id */
	function entityTypeLabel(id) {
		return id.startsWith(`${IdTypes.template}/`) ? 'T' : 'L';
	}

	// Bindings
	/** @type {HTMLInputElement} */
	let quick_add_list_item_input;
	/** @type {HTMLInputElement | undefined} */
	let edit_name_input = $state();
	/** @type {HTMLInputElement | undefined} */
	let picker_search_input = $state();
	/**
	 * Root container for the list view. Made focusable (tabindex="-1")
	 * so the list-view keymap (D.1+) can capture single-key shortcuts
	 * without colliding with native undo on editable surfaces. Focused
	 * on mount via `tick().then(focus)` so the cursor model has somewhere
	 * to live as soon as the list renders.
	 *
	 * @type {HTMLElement | undefined}
	 */
	let root_el = $state();

	// D.4 — edit panel id. When set, EditPanel renders.
	/** @type {string | null} */
	let editing_id = $state(null);

	// D.7 — overlays
	let show_cheatsheet = $state(false);
	let show_palette = $state(false);

	async function archiveCurrentList() {
		await mutateWithUndo.archiveList({ listId: list.id });
	}

	function navigateToShare() {
		const entityType = list.id.startsWith('t/') ? 't' : 'l';
		const suffix = list.id.split('/', 2)[1] ?? '';
		goto(`/${entityType}/${suffix}/share`);
	}

	// D.7 — keymap registry. Rebuilt reactively because actions
	// close over `mutateWithUndo` / `list` / overlay setters — Svelte
	// runes captures references via the thunks so this stays cheap.
	let registry = $derived(
		buildKeymapRegistry({
			openCheatsheet: () => {
				show_cheatsheet = true;
			},
			openPalette: () => {
				show_palette = true;
			},
			closeOverlays: () => {
				show_cheatsheet = false;
				show_palette = false;
			},
			archiveList: () => void archiveCurrentList(),
			navigateToShare,
			undo: () => void undoRuntime.undo(),
			redo: () => void undoRuntime.redo()
		})
	);

	// D.7 — Cmd+K and Cmd+Shift+A window listener. Cmd+K must open
	// the palette even when an input is focused, so we don't share
	// the editable-skip discipline of the list-view keymap. The
	// global.js Cmd+Z keymap still handles undo/redo/share.
	$effect(() => {
		/** @param {KeyboardEvent} event */
		function onWindowKey(event) {
			const mod = event.metaKey || event.ctrlKey;
			if (!mod) return;
			const key = event.key.toLowerCase();
			if (key === 'k' && !event.shiftKey) {
				event.preventDefault();
				show_palette = true;
				return;
			}
			if (key === 'a' && event.shiftKey) {
				// Don't hijack Cmd+Shift+A inside inputs — let native
				// select-all-and-friends behave.
				const t = event.target;
				if (
					t instanceof HTMLInputElement ||
					t instanceof HTMLTextAreaElement ||
					(t instanceof HTMLElement && t.isContentEditable)
				) {
					return;
				}
				event.preventDefault();
				void archiveCurrentList();
				return;
			}
		}
		window.addEventListener('keydown', onWindowKey);
		return () => window.removeEventListener('keydown', onWindowKey);
	});

	// D.1 cursor + D.2 verbs + D.4 callbacks. The verbs module composes
	// the cursor; we instantiate the outer one and proxy through.
	// Thunks for `list` / `data` so the module sees their reactive
	// values without us threading $state across module boundaries.
	const cursor = createListViewVerbs({
		getList: () => list,
		getData: () => data,
		// Every reactive value is passed as a thunk. Direct references
		// would trip state_referenced_locally — the destructured prop
		// bindings + $derived `list` capture initial values when read
		// in non-reactive scope (object-literal construction).
		getListId: () => list.id,
		getMutateWithUndo: () => mutateWithUndo,
		onOpenEditPanel: () => {
			editing_id = cursor.cursorId;
		},
		onOpenInlineCreate: () => {
			show_quick_add_item_form = true;
			tick().then(() => quick_add_list_item_input?.focus());
		},
		onOpenCheatsheet: () => {
			show_cheatsheet = true;
		}
	});

	// Element under edit (null when panel is closed).
	let editing_elem = $derived(editing_id ? data[editing_id] : null);

	$effect(() => {
		// Re-runs when the list mounts / remounts. tick() lets the DOM
		// settle before we yank focus — without it the focus call can
		// land on a detached node during the initial render.
		tick().then(() => {
			root_el?.focus();
		});
	});

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
				listId: list.id,
				name: trimmed
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
			itemId: elem_id,
			quantity: { ...elemData.value, value: newValue }
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

		// Inline-create routes through the undo path so Cmd+Z removes
		// the just-created item.
		const { error } = await tryCatchAsync(
			mutateWithUndo.createListItem({
				item: listItem
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

	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<article
		bind:this={root_el}
		data-elem-id={list.id}
		data-elem-type={list.type}
		tabindex="-1"
		class="outline-none"
		onkeydown={cursor.handleKeydown}
	>
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
				<!-- Editable title: a real <button> inside the heading gives
				     built-in keyboard activation (Enter/Space) and correct
				     semantics, so no a11y role override is needed. -->
				<h2 class="text-2xl">
					<button
						type="button"
						class="cursor-text border-0 bg-transparent p-0 text-left text-inherit"
						onclick={startEditName}
					>
						{#if list.name}
							{list.name}
						{:else}
							<span class="italic text-slate-500">Untitled List</span>
						{/if}
					</button>
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

		<!--
			Keyed each: pins each rendered row to its child_ref ID so
			remote inserts/deletes don't shuffle DOM nodes underneath the
			cursor (D.1+). Without the key Svelte reuses nodes by index,
			which jitters focus when a peer inserts above your position.
		-->
		{#each list.child_element_refs as child_ref (child_ref)}
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

	{#if editing_elem}
		<EditPanel
			elem={editing_elem}
			{mutateWithUndo}
			onClose={() => (editing_id = null)}
		/>
	{/if}

	{#if show_cheatsheet}
		<CheatsheetOverlay
			bindings={registry}
			onClose={() => (show_cheatsheet = false)}
		/>
	{/if}

	{#if show_palette}
		<CommandPalette
			bindings={registry}
			onClose={() => (show_palette = false)}
		/>
	{/if}
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
			onkeydown={(e) => {
				// After a successful submit we refocus this input so the
				// user can keep adding items. That leaves focus inside an
				// <input>, where the global Cmd+Z keymap defers to native
				// text-undo (global.js skips editable targets). When the
				// field is empty there's no in-progress edit to preserve,
				// so route Cmd+Z / Cmd+Shift+Z to the app undo runtime —
				// the user's intent is "undo the item I just added".
				const mod = e.metaKey || e.ctrlKey;
				if (!mod) return;
				if (e.key.toLowerCase() !== 'z') return;
				if (e.currentTarget.value !== '') return;
				e.preventDefault();
				if (e.shiftKey) void undoRuntime.redo();
				else void undoRuntime.undo();
			}}
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
	<!--
		Silently skip missing or soft-deleted children. Parent
		child_element_refs aren't pruned eagerly on archive — the row
		gets `time_deleted` set and the next pull emits `del` for the
		row key, but the parent's refs array still contains the id
		until the parent's own pull update lands. Showing "Element
		not found" during this normal flicker would be noisy. Cursor
		model already excludes missing rows from the flat sequence.
	-->
	{#if child && !child.time_deleted}
		{#if child.type === LIST_ELEMENT_TYPES.GROUP}
			{@render group(child)}
		{:else if child.type === LIST_ELEMENT_TYPES.ITEM}
			{@render item(child)}
		{:else}
			<p>UNSUPPORTED LIST ELEMENT TYPE: "{child.type}"</p>
		{/if}
	{/if}
{/snippet}

{#snippet group(
	/** @type {import("$djibb/list/index.ts").ListGroup} */
	elem
)}
	{@const is_collapsed = cursor.isCollapsed(elem.id)}
	{@const is_cursor = cursor.isCursor(elem.id)}
	{@const is_selected = cursor.isSelected(elem.id)}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<section
		class="my-8 px-1 {is_cursor ? 'ring-1 ring-slate-400' : ''} {is_selected ? 'bg-sky-100' : is_cursor ? 'bg-slate-100' : ''}"
		data-elem-id={elem.id}
		data-elem-type={elem.type}
		onclick={() => cursor.setCursor(elem.id)}
	>
		<h3 class="text-xl flex items-center gap-1">
			<span class="text-slate-500 select-none w-3 inline-block">
				{is_collapsed ? '▸' : '▾'}
			</span>
			{elem.name}
		</h3>
		{#if !is_collapsed}
			<div class="flex flex-col">
				{#each elem.child_element_refs as child_ref (child_ref)}
					{@render child(child_ref)}
				{:else}
					<p>Group has no child elements!</p>
				{/each}
			</div>
		{/if}
	</section>
{/snippet}

{#snippet item(
	/** @type {import("$djibb/list/index.ts").ListItem} */
	elem
)}
	{@const is_cursor = cursor.isCursor(elem.id)}
	{@const is_selected = cursor.isSelected(elem.id)}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="flex items-center gap-2 my-1 px-1 {is_cursor ? 'ring-1 ring-slate-400' : ''} {is_selected ? 'bg-sky-100' : is_cursor ? 'bg-slate-100' : ''}"
		onclick={() => cursor.setCursor(elem.id)}
	>
		<label class="flex items-center gap-2">
			<input
				data-elem-id={elem.id}
				data-elem-type={elem.type}
				oninput={handleCheckboxInput}
				name={elem.name}
				type="checkbox"
				checked={elem.value.value === elem.value.target_value}
			/>
			<span>{elem.name}</span>
		</label>

		{#if elem.references_entity_id}
			{@const ref_id = elem.references_entity_id}
			<a
				class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 border border-slate-300 rounded text-slate-700 hover:bg-slate-100"
				href={entityHref(ref_id)}
				title={`Linked: ${ref_id}`}
			>
				<span
					class="font-mono text-[10px] text-slate-500"
					aria-label={ref_id.startsWith(`${IdTypes.template}/`) ? 'template' : 'list'}
				>{entityTypeLabel(ref_id)}</span>
				<span>↗</span>
			</a>
		{/if}

		<button
			class="ml-auto cursor-pointer text-slate-500 hover:text-slate-800 p-1"
			onclick={() => openPicker(elem.id)}
			title="Link to another list or template"
			aria-label="Link to another list or template"
		>
			<IconLink size={16} stroke={1.5} />
		</button>
	</div>

	{#if picker_open_for === elem.id}
		{@render reference_picker(elem)}
	{/if}
{/snippet}

{#snippet reference_picker(
	/** @type {import("$djibb/list/index.ts").ListItem} */
	elem
)}
	<div class="ml-6 mb-2 border border-slate-300 bg-white rounded p-2 max-w-md">
		<div class="flex items-center gap-2 mb-2">
			<input
				bind:this={picker_search_input}
				class="flex-1 border-b border-slate-300 outline-none px-1 py-0.5 text-sm"
				placeholder="Search lists & templates…"
				bind:value={picker_query}
			/>
			<button
				class="text-slate-500 hover:text-slate-800 cursor-pointer"
				onclick={closePicker}
				aria-label="Close"
			>
				<IconX size={16} stroke={1.5} />
			</button>
		</div>

		{#if picker_loading}
			<p class="text-sm text-slate-500 italic">Loading…</p>
		{:else if picker_filtered.length === 0}
			<p class="text-sm text-slate-500 italic">
				{picker_entities.length === 0
					? 'No lists or templates yet.'
					: 'No matches.'}
			</p>
		{:else}
			<ul class="max-h-60 overflow-y-auto">
				{#each picker_filtered as candidate (candidate.id)}
					<li>
						<button
							class="w-full text-left flex items-center gap-2 px-1 py-1 hover:bg-slate-100 cursor-pointer rounded text-sm"
							onclick={() => pickReference(elem, candidate.id)}
						>
							<span
								class="font-mono text-[10px] w-4 h-4 inline-flex items-center justify-center border border-slate-300 rounded text-slate-600"
								aria-label={candidate.type}
							>{candidate.type === 'template' ? 'T' : 'L'}</span>
							<span class="flex-1 truncate">
								{candidate.name || (
									candidate.type === 'template' ? 'Untitled template' : 'Untitled list'
								)}
							</span>
							{#if candidate.id === elem.references_entity_id}
								<span class="text-xs text-slate-500">current</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		{#if elem.references_entity_id}
			<div class="border-t border-slate-200 mt-2 pt-2">
				<button
					class="text-xs text-red-700 hover:underline cursor-pointer"
					onclick={() => pickReference(elem, null)}
				>
					Clear reference
				</button>
			</div>
		{/if}
	</div>
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
