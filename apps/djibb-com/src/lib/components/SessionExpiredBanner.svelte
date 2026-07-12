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
	 *
	 * ## Two causes, not one
	 *
	 * `authBlocked` means "pushes are persistently 403'd", which is a
	 * symptom, not a diagnosis. There are two ways to get there, and
	 * telling the user the wrong one is worse than saying nothing:
	 *
	 *  - **The session is gone.** No accounts on the session at all.
	 *    This is the expiry case, and "Session expired" is true.
	 *
	 *  - **The acting account is not on the session.** Sessions here are
	 *    multi-account, and signing out of *one* of them leaves the
	 *    others live. A client that was already pushing as the account
	 *    you just left keeps claiming it in the mutation envelope, and
	 *    the DO's cross-account check rejects it outright
	 *    (`durable_object.ts`, "Cross-account check" — an unconditional
	 *    throw, unlike a role denial, which is skip-and-acked per ADR
	 *    0020 precisely so it can't wedge a push). The session is alive
	 *    and nothing expired. Telling that user "Session expired" is a
	 *    claim they can see is false, on a banner they cannot dismiss.
	 *
	 * Both want the same *action* — an interactive sign-in as the
	 * account that owns the work — so the destination is unchanged. Only
	 * the diagnosis and the button's promise differ.
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
	 * @property {string | null} actingAccountId
	 *   The account this Replicache client pushes as — the one stamped
	 *   into every mutation envelope. Not the session's current account:
	 *   it's fixed when the client is built, which is exactly why it can
	 *   drift out of the session while the session stays alive.
	 * @property {readonly { id: string, user_name?: string | null }[]} sessionAccounts
	 *   Accounts currently on the session. Empty means no session.
	 *   `readonly` to match what `sessionState.accounts` hands over — this
	 *   only ever reads them.
	 */

	/** @type {Props} */
	let { status, signInHref, onRetry, actingAccountId, sessionAccounts } =
		$props();

	let visible = $derived(status.authBlocked);

	/**
	 * Which of the two causes we're looking at. `signed-out` is only
	 * claimable when we can see accounts on the session AND the account
	 * we're pushing as isn't among them — anything else falls back to
	 * `expired`, which is the safe answer: it never asserts a live
	 * session that isn't there.
	 */
	let cause = $derived(
		sessionAccounts.length > 0 &&
			actingAccountId &&
			!sessionAccounts.some((a) => a.id === actingAccountId)
			? 'signed-out'
			: 'expired'
	);

	// The count is Replicache's real queue depth, so it's honest even
	// when it's zero — an expired session with nothing queued is worth
	// saying plainly rather than claiming "0 unsaved changes".
	let changes = $derived(
		status.pending === 1 ? '1 unsaved change' : `${status.pending} unsaved changes`
	);

	// Who they ARE signed in as, which is the fact that makes "Session
	// expired" read as a lie in the signed-out case. Naming them is what
	// makes the real explanation land.
	let signedInAs = $derived(
		sessionAccounts
			.map((a) => a.user_name)
			.filter(Boolean)
			.join(', ')
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
		data-cause={cause}
	>
		{#if cause === 'signed-out'}
			<p>
				<strong>These changes belong to another account</strong> — the
				{#if status.pending > 0}{changes}{:else}work{/if}
				here {status.pending === 1 ? 'was' : 'were'} made as an account you've
				since signed out of{#if signedInAs}, not {signedInAs}{/if}. Only
				that account can save {status.pending === 1 ? 'it' : 'them'}. Sign
				back in and they'll finish saving on their own.
			</p>
			<a class="primary" href={signInHref}>Sign in to that account</a>
		{:else}
			<p>
				<strong>Session expired</strong> — sign in to save your
				{#if status.pending > 0}{changes}{:else}work{/if}. Your edits are
				safe here until you do.
			</p>
			<a class="primary" href={signInHref}>Sign in</a>
		{/if}
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
