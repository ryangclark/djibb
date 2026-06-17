<script>
	// @ts-check
	/**
	 * Per-list undo / outcome toast. Mounted by /l and /t routes
	 * after the undo runtime is created.
	 *
	 * Most-recent-wins collapse: a new toast replaces whatever's
	 * showing, cancels the active dismiss timer, starts a fresh one.
	 * Per ADR 0005's "rapid-fire collapse" requirement — keeps the UI
	 * surface single-toast, never queued.
	 *
	 * Action toasts (kind='action') show the Undo CTA + a "Cmd+Z"
	 * shortcut hint; clicking the CTA calls `onUndo` (the route wires
	 * this to `undoRuntime.undo`). Outcome toasts (kind='auth'|'stale'|
	 * 'gone') show the failure reason — no CTA since the mutation
	 * didn't apply.
	 *
	 * Auto-dismiss after `DISMISS_MS` (5s). Persists on hover so the
	 * user can read it before deciding to undo.
	 */

	import { onDestroy } from 'svelte';

	/**
	 * @typedef {import('$lib/replicache/withUndo.svelte.js').ToastEvent} ToastEvent
	 */

	const DISMISS_MS = 5000;

	/**
	 * @typedef {object} Props
	 * @property {ToastEvent | null} event
	 *   Set by parent on every runtime `onToast` callback. Reactivity
	 *   on this prop kicks the auto-dismiss timer.
	 * @property {() => void} onUndo
	 *   Wired to `undoRuntime.undo()` by the parent route.
	 */
	/** @type {Props} */
	let { event, onUndo } = $props();

	/** @type {ToastEvent | null} */
	let active = $state(null);
	let dismissTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
	let hovered = $state(false);

	// Most-recent-wins: any new event replaces the active toast and
	// resets the dismiss timer. Hovering pauses the timer until exit.
	$effect(() => {
		if (event === null) return;
		active = event;
		armDismiss();
	});

	function armDismiss() {
		if (dismissTimer) clearTimeout(dismissTimer);
		if (hovered) return;
		dismissTimer = setTimeout(() => {
			active = null;
			dismissTimer = null;
		}, DISMISS_MS);
	}

	function dismiss() {
		if (dismissTimer) clearTimeout(dismissTimer);
		dismissTimer = null;
		active = null;
	}

	function handleMouseEnter() {
		hovered = true;
		if (dismissTimer) {
			clearTimeout(dismissTimer);
			dismissTimer = null;
		}
	}

	function handleMouseLeave() {
		hovered = false;
		armDismiss();
	}

	onDestroy(() => {
		if (dismissTimer) clearTimeout(dismissTimer);
	});

	/** @param {string} name */
	function humanizeMutator(name) {
		// Lightweight: split camelCase, lowercase the rest. Good enough
		// for the action toast's "<verb> <noun>" surface; a richer
		// label registry can land later if copy nuance matters.
		return name
			.replace(/([A-Z])/g, ' $1')
			.replace(/^./, (c) => c.toUpperCase())
			.trim();
	}

	/** @param {ToastEvent} e */
	function actionLabel(e) {
		if (e.kind !== 'action') return '';
		return humanizeMutator(e.entry.forwardName);
	}

	/** @param {ToastEvent} e */
	function outcomeLabel(e) {
		// Server-attached `message` wins when present (ADR 0009 Slice 3):
		// preflight-driven failures ship specific copy like "That account
		// already has access" or "Rate limit: max 10 invitations per
		// hour." Fall back to the generic per-kind copy for legacy
		// outcome paths (CAS-stale / role-gate / target-gone) that
		// don't attach a message.
		if (e.kind === 'action') return '';
		if (e.message) return e.message;
		switch (e.kind) {
			case 'auth':
				return 'Action blocked — your role changed';
			case 'stale':
				return 'Action overridden by another change';
			case 'gone':
				return 'Action target no longer exists';
			case 'precondition':
				return 'Action blocked — not in a valid state';
			default:
				return '';
		}
	}

	function handleUndoClick() {
		dismiss();
		onUndo();
	}
</script>

{#if active}
	<div
		class="toast"
		role="status"
		aria-live="polite"
		onmouseenter={handleMouseEnter}
		onmouseleave={handleMouseLeave}
	>
		{#if active.kind === 'action'}
			<span class="label">{actionLabel(active)}</span>
			<button class="undo-cta" type="button" onclick={handleUndoClick}>
				Undo <kbd>⌘Z</kbd>
			</button>
		{:else}
			<span class="label outcome">{outcomeLabel(active)}</span>
		{/if}
		<button
			class="close"
			type="button"
			aria-label="Dismiss"
			onclick={dismiss}>×</button
		>
	</div>
{/if}

<style>
	.toast {
		position: fixed;
		bottom: 1.5rem;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 1rem;
		background: #1f1f23;
		color: #fff;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
		font-size: 0.9rem;
		z-index: 1000;
		min-width: 18rem;
		max-width: 32rem;
	}
	.label {
		flex: 1;
	}
	.label.outcome {
		color: #f5a;
	}
	.undo-cta {
		background: transparent;
		color: #6cf;
		border: none;
		padding: 0.25rem 0.5rem;
		font: inherit;
		cursor: pointer;
		border-radius: 4px;
	}
	.undo-cta:hover {
		background: rgba(108, 204, 255, 0.12);
	}
	.undo-cta kbd {
		font-size: 0.75em;
		padding: 0 0.2em;
		margin-left: 0.25em;
		border: 1px solid rgba(255, 255, 255, 0.3);
		border-radius: 3px;
	}
	.close {
		background: transparent;
		color: rgba(255, 255, 255, 0.5);
		border: none;
		font-size: 1.2rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.25rem;
	}
	.close:hover {
		color: rgba(255, 255, 255, 0.9);
	}
</style>
