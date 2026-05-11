<script>
	// @ts-check
	/**
	 * Command palette — D.7.
	 *
	 * Substring-filtered list of actionable bindings (those with a
	 * non-null `action`). Enter fires the highlighted command.
	 * ↑/↓ navigate, Esc dismisses.
	 *
	 * Filtering is delegated to filterPaletteBindings for testability;
	 * navigation cursor lives here as $state since it's UI-local.
	 *
	 * @typedef {object} Props
	 * @property {import('$lib/keymap/registry.js').Binding[]} bindings
	 * @property {() => void} onClose
	 */

	import { tick } from 'svelte';
	import { filterPaletteBindings } from '$lib/keymap/registry.js';

	/** @type {Props} */
	let { bindings, onClose } = $props();

	let query = $state('');
	let selectedIdx = $state(0);

	let filtered = $derived(filterPaletteBindings(bindings, query));

	/** @type {HTMLInputElement | undefined} */
	let query_input = $state();

	$effect(() => {
		tick().then(() => query_input?.focus());
	});

	$effect(() => {
		// Reset highlight when filter shrinks under it.
		if (selectedIdx >= filtered.length) selectedIdx = 0;
	});

	/** @param {KeyboardEvent} event */
	function handleKeydown(event) {
		// Capture at panel level so the list keymap doesn't double-fire.
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			event.stopPropagation();
			if (filtered.length > 0) {
				selectedIdx = (selectedIdx + 1) % filtered.length;
			}
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			if (filtered.length > 0) {
				selectedIdx = (selectedIdx - 1 + filtered.length) % filtered.length;
			}
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			const command = filtered[selectedIdx];
			if (command?.action) {
				onClose();
				// Defer to next tick so the overlay actually unmounts
				// before the action fires (some actions navigate or
				// open another overlay).
				tick().then(() => command.action?.());
			}
			return;
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 z-[960] flex items-start justify-center pt-24 bg-black/40"
	role="dialog"
	aria-modal="true"
	aria-label="Command palette"
	onclick={onClose}
	onkeydown={handleKeydown}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bg-white max-w-xl w-full shadow-xl rounded overflow-hidden"
		onclick={(/** @type {MouseEvent} */ e) => e.stopPropagation()}
	>
		<input
			bind:this={query_input}
			bind:value={query}
			class="w-full px-3 py-2 border-b border-slate-200 outline-none text-sm"
			placeholder="Type a command…"
		/>
		{#if filtered.length === 0}
			<div class="px-3 py-6 text-sm text-slate-500 italic">No matches.</div>
		{:else}
			<ul class="max-h-80 overflow-y-auto">
				{#each filtered as cmd, i (cmd.keyDisplay + cmd.label)}
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<li
						class="flex items-center justify-between gap-3 px-3 py-2 cursor-pointer text-sm {i === selectedIdx ? 'bg-slate-100' : 'hover:bg-slate-50'}"
						onclick={() => {
							onClose();
							tick().then(() => cmd.action?.());
						}}
						onmouseenter={() => (selectedIdx = i)}
					>
						<div class="flex-1">
							<div>{cmd.label}</div>
							<div class="text-xs text-slate-500">{cmd.category}</div>
						</div>
						<kbd
							class="font-mono text-xs bg-slate-100 border border-slate-300 px-1.5 py-0.5 rounded"
						>
							{cmd.keyDisplay}
						</kbd>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
