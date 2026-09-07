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
	 *
	 * The inference itself lives in `@djibb/client` (`diagnoseAuthBlock`),
	 * not here: deciding what we assert to a user about the state of their
	 * session is authorization reasoning, and it belongs somewhere it can
	 * be tested directly rather than inside an untested `$derived`. This
	 * component only renders the answer.
	 *
	 * ## The escape hatch (GH #45)
	 *
	 * Non-dismissible is right for the person who owns the work. It is a
	 * trap for anyone else. The ledger fallback in `resolveEffectiveAccount`
	 * is keyed on the entity, not the human, so on a shared device a
	 * genuinely anonymous visitor can land here acting as an account that
	 * left work behind — shown a banner about someone else's changes and
	 * unable to edit the list anonymously until that account returns.
	 * Preserving the work by default is still correct (discarding it
	 * silently would destroy something real), so the way out is an
	 * *explicit* choice.
	 *
	 * When there is no live session — the actual #45 trap — the banner does
	 * not diagnose *who* the work belongs to, because it cannot and because
	 * naming an absent account discloses them to whoever is now at the
	 * screen. Instead it offers two neutral forward paths: **Sign in to
	 * resume** (the owner picks their work back up — no code beyond re-auth;
	 * the store and claim are untouched, so the client rebuilds as that
	 * account and the queue drains) and **Discard and continue** (anyone
	 * else clears it and edits anonymously). The safe path stays the primary,
	 * filled action; discard is the lower-weight outline beside it.
	 *
	 * The discard is only offered in the no-session case. When a *live*
	 * session is acting as an account it lacks (the `signed-out` cause), the
	 * same stranded work is already surfaced by `StrandedWorkBanner`, which
	 * owns the switch/discard choice (GH #46); a second discard here was
	 * redundant for the same work, so it is not rendered.
	 *
	 * `canDisownAuthBlock` says when a disown may be offered at all — only
	 * while acting as an account the session cannot vouch for. The discard
	 * itself is the page's (`onDisown`): it has to close the live client
	 * before the store can be dropped, then rebuild it as whoever the
	 * session actually says we are.
	 */
	import { onMount } from 'svelte';
	import {
		canDisownAuthBlock,
		diagnoseAuthBlock
	} from '@djibb/client/syncStatus';

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
	 * @property {() => void} onDisown
	 *   Throw away the blocked work on this entity and rebuild the client
	 *   as whoever the session says we are (GH #45). Irreversible; only
	 *   ever fired by the user's own click.
	 * @property {boolean} disowning
	 *   A disown is in progress — disables the button and swaps its label.
	 * @property {string} disownError
	 *   Why the last disown failed, if it did. Empty when it didn't.
	 */

	/** @type {Props} */
	let {
		status,
		signInHref,
		onRetry,
		actingAccountId,
		sessionAccounts,
		onDisown,
		disowning,
		disownError
	} = $props();

	let visible = $derived(status.authBlocked);

	let cause = $derived(
		diagnoseAuthBlock({ actingAccountId, sessionAccounts })
	);

	let canDisown = $derived(
		canDisownAuthBlock({ actingAccountId, sessionAccounts })
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
			<!-- No discard offered here. On a live session the same stranded
			     work is surfaced by StrandedWorkBanner, which owns the
			     switch/discard choice (GH #46); a second discard control on
			     this banner was redundant for the same work. The disown path
			     below is only for the no-session trap. -->
		{:else if canDisown}
			<!-- The #45 trap: no live session, acting from a leftover ledger
			     claim on this entity. The person here is either the owner
			     returning or someone else on a shared device — the browser
			     cannot tell, and only they can. So two neutral forward paths,
			     neither naming the account: the owner signs in and resumes;
			     anyone else discards and continues. Framing the choice this
			     way (rather than "Not you?") discloses nothing about *whose*
			     work it was, which is the privacy-respecting default on a
			     shared device. -->
			<p>
				{#if status.pending > 0}
					<strong>Unsaved changes from a previous session</strong> —
					there {status.pending === 1 ? 'is' : 'are'} {changes} here
					from a session that's no longer signed in. Sign in to pick
					{status.pending === 1 ? 'it' : 'them'} back up, or discard
					{status.pending === 1 ? 'it' : 'them'} to continue.
				{:else}
					<strong>Leftover work from a previous session</strong> — a
					session that's no longer signed in left work here. Sign in
					to pick it back up, or discard it to continue.
				{/if}
			</p>
			<div class="actions">
				<a class="primary" href={signInHref}>Sign in to resume</a>
				<button
					type="button"
					class="discard"
					disabled={disowning}
					onclick={onDisown}
				>
					{disowning ? 'Discarding…' : 'Discard and continue'}
				</button>
			</div>
			{#if disownError}
				<p class="error">{disownError}</p>
			{/if}
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
	/* The two forward paths sit together; the primary (filled) sign-in
	   stays the visually dominant, safe default and the discard is a
	   lower-weight outline button beside it. */
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		flex: none;
	}
	.actions .discard {
		background: none;
		border: 1px solid #b91c1c;
		color: #7f1d1d;
		padding: 0.4rem 0.9rem;
		border-radius: 0.35rem;
		cursor: pointer;
		flex: none;
	}
	.actions .discard:disabled {
		opacity: 0.5;
	}
	.error {
		flex-basis: 100%;
		font-size: 0.85rem;
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
