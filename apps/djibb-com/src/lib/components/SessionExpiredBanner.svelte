<script>
	// @ts-check
	/**
	 * GH #6 — the session-expired interrupt.
	 *
	 * Follow-up to the push auth-reconciliation policy in the DO
	 * (`handleMutation`): an *unauthenticated* push throws rather than
	 * being skip-and-acked, so the mutation stays queued and survives
	 * re-auth. That preservation is correct but invisible — the local
	 * state still looks saved while nothing reaches the server, and
	 * closing the tab would lose the edits. This banner is what turns
	 * "safe but stuck" into "recoverable".
	 *
	 * Deliberately not dismissible: the user has unsaved work that
	 * *cannot* be saved without signing in again, and there is no
	 * silent recovery to fall back on — djibb has no refresh token
	 * (magic-link / OAuth + HttpOnly cookie), so re-auth is
	 * necessarily interactive (silent renewal is GH #3). Dismissing
	 * would just restore the invisibility this exists to remove.
	 *
	 * Nothing here drops or replays mutations. The queue is
	 * Replicache's; once a fresh cookie is in place its normal retry
	 * flushes it, the pending count falls to zero, `authBlocked`
	 * clears on the first successful push, and the banner disappears
	 * on its own.
	 */
	import { onMount } from 'svelte';

	/**
	 * @typedef {Object} Props
	 * @property {import('@djibb/client/syncStatus').SyncStatus} status
	 * @property {string} signInHref
	 * @property {() => void} onRetry
	 *   Nudges Replicache to push now. Called when the tab regains
	 *   focus while blocked — i.e. the user probably just signed in
	 *   somewhere — so the queue drains immediately instead of waiting
	 *   out the push retry backoff.
	 */

	/** @type {Props} */
	let { status, signInHref, onRetry } = $props();

	let visible = $derived(status.authBlocked);

	// The count is Replicache's real queue depth, so it's honest even
	// when it's zero — an expired session with nothing queued is worth
	// saying plainly rather than claiming "0 unsaved changes".
	let changes = $derived(
		status.pending === 1 ? '1 unsaved change' : `${status.pending} unsaved changes`
	);

	onMount(() => {
		function onFocus() {
			if (status.authBlocked) onRetry();
		}
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});
</script>

{#if visible}
	<!-- assertive: unlike the ambient indicator, this one is meant to
	     interrupt — there is unsaved work that cannot be saved. -->
	<aside
		class="session-expired"
		role="alert"
		aria-live="assertive"
		data-testid="session-expired-banner"
	>
		<p>
			<strong>Session expired</strong> — sign in to save your
			{#if status.pending > 0}{changes}{:else}work{/if}. Your edits are
			safe here until you do.
		</p>
		<a class="primary" href={signInHref}>Sign in</a>
	</aside>
{/if}

<style>
	.session-expired {
		position: sticky;
		top: 0;
		z-index: 40;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
		justify-content: space-between;
		border: 1px solid #fecaca;
		background: #fef2f2;
		color: #7f1d1d;
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		margin: 0.75rem 0;
	}
	.session-expired p {
		margin: 0;
	}
	.session-expired a.primary {
		background: #b91c1c;
		color: white;
		border: none;
		padding: 0.4rem 0.9rem;
		border-radius: 0.35rem;
		text-decoration: none;
		cursor: pointer;
		flex: none;
	}
</style>
