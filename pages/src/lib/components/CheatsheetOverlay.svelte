<script>
	// @ts-check
	/**
	 * Cheatsheet overlay — D.7.
	 *
	 * Renders the full registry grouped by category. Opened by `?`,
	 * dismissed by Esc or click outside.
	 *
	 * @typedef {object} Props
	 * @property {import('$lib/keymap/registry.js').Binding[]} bindings
	 * @property {() => void} onClose
	 */

	import { groupByCategory } from '$lib/keymap/registry.js';

	/** @type {Props} */
	let { bindings, onClose } = $props();

	let grouped = $derived(groupByCategory(bindings));

	/** @param {KeyboardEvent} event */
	function handleKeydown(event) {
		if (event.key === 'Escape' || event.key === '?') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 z-[950] flex items-center justify-center bg-black/40"
	onclick={onClose}
	role="dialog"
	aria-modal="true"
	aria-label="Keyboard cheatsheet"
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bg-white max-w-3xl w-full max-h-[80vh] overflow-y-auto p-6 shadow-xl rounded"
		onclick={(/** @type {MouseEvent} */ e) => e.stopPropagation()}
	>
		<div class="flex justify-between items-baseline mb-4">
			<h2 class="text-xl font-semibold">Keyboard shortcuts</h2>
			<span class="text-xs text-slate-500">Press Esc or ? to close</span>
		</div>
		<div class="grid grid-cols-2 gap-x-6 gap-y-4">
			{#each grouped as [category, items] (category)}
				<section>
					<h3 class="text-sm font-semibold uppercase text-slate-500 mb-2">
						{category}
					</h3>
					<ul class="space-y-1">
						{#each items as b (b.keyDisplay + b.label)}
							<li class="flex justify-between gap-3 text-sm">
								<span>{b.label}</span>
								<kbd
									class="font-mono text-xs bg-slate-100 border border-slate-300 px-1.5 py-0.5 rounded"
								>
									{b.keyDisplay}
								</kbd>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</div>
</div>
