<script>
	// @ts-check
	/**
	 * Edit panel — Slice D of ADR 0004.
	 *
	 * Minimal first cut. Renders name + description for any row, plus
	 * target_value for items. Future slices can fold in the reference
	 * picker, min/max bounds, group-cascade settings, etc.
	 *
	 * Behavior:
	 *   - Cmd+Enter commits only dirty fields via setItemFields /
	 *     setGroupFields through the undo-pushing path
	 *   - Esc discards (component is uncontrolled until commit; nothing
	 *     to roll back)
	 *   - Esc + Cmd+Enter are captured at the panel container's keydown
	 *     so they don't bubble to the list keymap. The list keymap also
	 *     bails on inputs, but Cmd+Enter and Esc are special.
	 *
	 * @typedef {object} Props
	 * @property {{
	 *   id: string,
	 *   type: 'item' | 'group',
	 *   name?: string | null,
	 *   description?: string | null,
	 *   value?: { value: number, target_value: number, unit: string,
	 *            min_value?: number | null, max_value?: number | null }
	 * }} elem The row being edited.
	 * @property {{
	 *   setItemFields: (args: { id: string, fields: any, expected?: any }) => Promise<any>,
	 *   setGroupFields: (args: { id: string, fields: any, expected?: any }) => Promise<any>,
	 * }} mutateWithUndo
	 * @property {() => void} onClose
	 */

	import { tick } from 'svelte';
	import IconX from '@tabler/icons-svelte/icons/x';

	/** @type {Props} */
	let { elem, mutateWithUndo, onClose } = $props();

	// Working drafts. Pre-filled from the row, edited freely. We
	// compare against the original on commit to detect dirty fields.
	let name_draft = $state(elem.name ?? '');
	let description_draft = $state(elem.description ?? '');
	let target_draft = $state(elem.value?.target_value ?? 1);

	/** @type {HTMLInputElement | undefined} */
	let name_input = $state();

	$effect(() => {
		// Focus the first field on mount — list keymap can't fire
		// inside the panel because of the editable-surface skip rule.
		tick().then(() => name_input?.focus());
	});

	async function commit() {
		/** @type {Record<string, any>} */
		const fields = {};
		/** @type {Record<string, any>} */
		const expected = {};

		const trimmedName = name_draft.trim();
		if (trimmedName !== (elem.name ?? '')) {
			fields.name = trimmedName;
			expected.name = elem.name ?? '';
		}

		const trimmedDesc = description_draft.trim();
		if (trimmedDesc !== (elem.description ?? '')) {
			fields.description = trimmedDesc;
			expected.description = elem.description ?? '';
		}

		// Items: target_value lives inside the `value` blob, so we
		// stage it through the value field with the full quantity
		// object preserved.
		if (elem.type === 'item' && elem.value) {
			const targetNum = Number(target_draft);
			if (
				Number.isFinite(targetNum) &&
				targetNum !== elem.value.target_value
			) {
				fields.value = { ...elem.value, target_value: targetNum };
				expected.value = elem.value;
			}
		}

		if (Object.keys(fields).length === 0) {
			onClose();
			return;
		}

		if (elem.type === 'item') {
			await mutateWithUndo.setItemFields({
				id: elem.id,
				fields,
				expected
			});
		} else {
			await mutateWithUndo.setGroupFields({
				id: elem.id,
				fields,
				expected
			});
		}
		onClose();
	}

	/** @param {KeyboardEvent} event */
	function handleKeydown(event) {
		const mod = event.metaKey || event.ctrlKey;
		if (mod && event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			void commit();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			return;
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="fixed inset-0 z-[900] flex items-start justify-end bg-black/20"
	role="dialog"
	aria-modal="true"
	onkeydown={handleKeydown}
>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bg-white w-full max-w-md h-full p-4 shadow-xl"
		onclick={(/** @type {MouseEvent} */ e) => e.stopPropagation()}
	>
		<div class="flex justify-between items-center mb-4">
			<h2 class="text-lg font-semibold">
				Edit {elem.type === 'item' ? 'item' : 'group'}
			</h2>
			<button
				class="text-slate-500 hover:text-slate-800 cursor-pointer"
				onclick={onClose}
				aria-label="Close"
			>
				<IconX size={20} stroke={1.5} />
			</button>
		</div>

		<label class="block mb-3">
			<span class="block text-sm text-slate-700 mb-1">Name</span>
			<input
				bind:this={name_input}
				bind:value={name_draft}
				class="w-full border border-slate-300 px-2 py-1 outline-none focus:border-slate-500"
			/>
		</label>

		<label class="block mb-3">
			<span class="block text-sm text-slate-700 mb-1">Description</span>
			<textarea
				bind:value={description_draft}
				class="w-full border border-slate-300 px-2 py-1 outline-none focus:border-slate-500"
				rows="3"
			></textarea>
		</label>

		{#if elem.type === 'item' && elem.value}
			<label class="block mb-3">
				<span class="block text-sm text-slate-700 mb-1">
					Target value ({elem.value.unit})
				</span>
				<input
					type="number"
					bind:value={target_draft}
					class="w-full border border-slate-300 px-2 py-1 outline-none focus:border-slate-500"
				/>
			</label>
		{/if}

		<div class="flex gap-2 mt-6">
			<button
				class="border border-slate-700 bg-slate-700 text-white px-3 py-1 cursor-pointer hover:bg-slate-800"
				onclick={() => void commit()}
			>
				Save (⌘↵)
			</button>
			<button
				class="border border-slate-300 px-3 py-1 cursor-pointer hover:bg-slate-100"
				onclick={onClose}
			>
				Cancel (Esc)
			</button>
		</div>

		<p class="text-xs text-slate-500 mt-4">
			ID: <code>{elem.id}</code>
		</p>
	</div>
</div>
