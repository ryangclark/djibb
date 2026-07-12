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
	 * Three states, all read off the shared sync tracker:
	 *   - can't sync   → pushes persistently rejected on auth
	 *   - N pending    → queued (or in flight, if a sync is running)
	 *   - all saved    → the queue is empty
	 */

	/**
	 * @typedef {Object} Props
	 * @property {import('@djibb/client/syncStatus').SyncStatus} status
	 * @property {string} signInHref
	 */

	/** @type {Props} */
	let { status, signInHref } = $props();

	let phase = $derived(
		status.authBlocked ? 'blocked' : status.pending > 0 ? 'pending' : 'saved'
	);

	let label = $derived(
		phase === 'blocked'
			? "Can't sync"
			: phase !== 'pending'
				? 'All changes saved'
				: status.syncing
					? 'Syncing…'
					: `${status.pending} pending`
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
	.pending .dot {
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
