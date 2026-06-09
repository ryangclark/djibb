<script module>
	// @ts-check
	/**
	 * @typedef {object} Pending
	 * @property {string} mutator Forward mutator's wire name (the
	 *   thing the user wants to undo).
	 * @property {(ok: boolean) => void} resolve Callback into the
	 *   runtime's awaited onConfirm Promise.
	 *
	 * Exported from the module context so routes can reference it via
	 * `import('./ConfirmToast.svelte').Pending` when bridging the
	 * runtime's `onConfirm` Promise to this prompt.
	 */
</script>

<script>
	// @ts-check
	/**
	 * Two-step friction prompt for undoing mutators that cross an
	 * authority or structural threshold (auth-rules change, list
	 * creation). Per ADR 0005 §"Friction tiers."
	 *
	 * Modal-ish: it blocks the undo flow. The runtime's `onConfirm`
	 * hook returns a Promise; the route bridges Promise ↔ prompt by
	 * stashing the resolver and the mutator name on the `pending`
	 * prop. User choice (click or `y`/`n` hotkey) resolves the
	 * promise.
	 *
	 * Distinct from `<UndoToast>` because:
	 *   - No auto-dismiss — explicit choice required.
	 *   - Captures keyboard for y/n while open.
	 *   - Holds a callback into the runtime's await chain, not a
	 *     fire-and-forget signal.
	 */

	/**
	 * @typedef {object} Props
	 * @property {Pending | null} pending
	 *   Set by the route when the runtime's `onConfirm` fires; cleared
	 *   here after the user chooses.
	 * @property {(pending: Pending | null) => void} setPending
	 *   Two-way handle: the component clears `pending` after choice,
	 *   the route observes that to reset.
	 */
	/** @type {Props} */
	let { pending, setPending } = $props();

	function choose(/** @type {boolean} */ ok) {
		if (!pending) return;
		pending.resolve(ok);
		setPending(null);
	}

	/**
	 * Y/N hotkey capture. Only intercepts when the prompt is open;
	 * once dismissed, normal keyboard flow resumes. Lives at the
	 * window level so the user doesn't have to focus the toast.
	 *
	 * @param {KeyboardEvent} event
	 */
	function handleKey(event) {
		if (!pending) return;
		// Ignore modifier-combined keystrokes — let Cmd+Z etc. through.
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		// Don't intercept while the user's typing in a field.
		const t = event.target;
		if (
			t instanceof HTMLInputElement ||
			t instanceof HTMLTextAreaElement ||
			(t instanceof HTMLElement && t.isContentEditable)
		) {
			return;
		}
		if (event.key === 'y' || event.key === 'Y') {
			event.preventDefault();
			choose(true);
		} else if (event.key === 'n' || event.key === 'N' || event.key === 'Escape') {
			event.preventDefault();
			choose(false);
		}
	}

	/** @param {string} name */
	function humanize(name) {
		return name
			.replace(/([A-Z])/g, ' $1')
			.replace(/^./, (c) => c.toUpperCase())
			.trim();
	}
</script>

<svelte:window onkeydown={handleKey} />

{#if pending}
	<div class="confirm" role="alertdialog" aria-modal="true" aria-live="assertive">
		<p class="prompt">
			Undo <strong>{humanize(pending.mutator)}</strong>?
		</p>
		<div class="actions">
			<button type="button" class="yes" onclick={() => choose(true)}>
				Yes <kbd>Y</kbd>
			</button>
			<button type="button" class="no" onclick={() => choose(false)}>
				No <kbd>N</kbd>
			</button>
		</div>
	</div>
{/if}

<style>
	.confirm {
		position: fixed;
		bottom: 1.5rem;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
		padding: 0.9rem 1.2rem;
		background: #2a1f23;
		color: #fff;
		border: 1px solid #c4a;
		border-radius: 8px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
		font-size: 0.95rem;
		z-index: 1100; /* above UndoToast */
		min-width: 18rem;
	}
	.prompt {
		margin: 0;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	button {
		font: inherit;
		padding: 0.3rem 0.7rem;
		border-radius: 4px;
		cursor: pointer;
		border: 1px solid rgba(255, 255, 255, 0.3);
		background: transparent;
		color: #fff;
	}
	button.yes:hover {
		background: rgba(108, 204, 108, 0.15);
		border-color: rgba(108, 204, 108, 0.6);
	}
	button.no:hover {
		background: rgba(255, 108, 108, 0.15);
		border-color: rgba(255, 108, 108, 0.6);
	}
	kbd {
		font-size: 0.75em;
		padding: 0 0.25em;
		margin-left: 0.25em;
		border: 1px solid rgba(255, 255, 255, 0.3);
		border-radius: 3px;
	}
</style>
