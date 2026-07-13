<script>
	// @ts-check
	/**
	 * GH #7 — the ambient "is my work safe?" readout.
	 *
	 * Optimistic local state looks identical whether a mutation
	 * reached the server or is stuck in a queue that can never drain,
	 * which is a trust-killer for an offline-first app. This is the
	 * quiet, always-visible counterpart to `SessionExpiredBanner`:
	 * the banner is the loud interrupt for the auth case, this just
	 * tells you the truth at a glance.
	 *
	 * Four states. Three are read off the shared sync tracker:
	 *   - can't sync   → pushes persistently rejected on auth
	 *   - N pending    → queued (or in flight, if a sync is running)
	 *   - all saved    → the queue is empty
	 *
	 * ...and the fourth is not about us at all:
	 *   - other unsaved → OUR queue is empty, but another account has
	 *     unflushed work on this entity (GH #46, `strandedClaims`).
	 *
	 * That last one exists because "the queue is empty" and "everything on
	 * this list is saved" are different claims, and the tracker only knows
	 * the first. On a multi-account device the gap between them is real:
	 * account A's stranded mutations live in a store B never opens, so B's
	 * queue is honestly empty while the list demonstrably has unsaved work
	 * on it. Saying **All changes saved** there is the precise lie #43 and
	 * #46 exist to kill — and it is the one a user is most likely to act
	 * on, because it's the sentence that makes them close the tab.
	 *
	 * The banner is the loud version of this; the indicator merely refuses
	 * to contradict it once the banner is scrolled past.
	 */

	/**
	 * @typedef {Object} Props
	 * @property {import('@djibb/client/syncStatus').SyncStatus} status
	 * @property {string} signInHref
	 * @property {boolean} [stranded]
	 *   Another account has unflushed work on this entity. Not derivable
	 *   from `status` — it is a fact about a store this client does not
	 *   have open.
	 */

	/** @type {Props} */
	let { status, signInHref, stranded = false } = $props();

	let phase = $derived(
		status.authBlocked
			? 'blocked'
			: status.pending > 0
				? 'pending'
				: stranded
					? 'stranded'
					: 'saved'
	);

	let label = $derived(
		phase === 'blocked'
			? "Can't sync"
			: phase === 'pending'
				? status.syncing
					? 'Syncing…'
					: `${status.pending} pending`
				: phase === 'stranded'
					? 'Unsaved changes from another account'
					: 'All changes saved'
	);
</script>

<!-- Polite, not assertive: this is ambient. The banner is what
     interrupts. -->
<div
	class="sync-indicator {phase}"
	role="status"
	aria-live="polite"
	data-testid="sync-indicator"
>
	<span class="dot" aria-hidden="true"></span>
	<span class="label">{label}</span>
	{#if phase === 'blocked'}
		<a href={signInHref}>Sign in</a>
	{/if}
</div>

<style>
	.sync-indicator {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
		color: #57534e;
		white-space: nowrap;
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: #a8a29e;
		flex: none;
	}
	.saved .dot {
		background: #16a34a;
	}
	.pending .dot,
	.stranded .dot {
		background: #d97706;
	}
	.blocked .dot {
		background: #dc2626;
	}
	.blocked {
		color: #b91c1c;
	}
	.sync-indicator a {
		color: inherit;
		text-decoration: underline;
	}
</style>
