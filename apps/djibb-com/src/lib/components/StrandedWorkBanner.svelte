<script>
	// @ts-check
	/**
	 * GH #46 — the honest answer to "another account has unsaved changes
	 * on this list."
	 *
	 * ## The state this exists for
	 *
	 * Sessions here are multi-account. Signed in as A and B: edit a list
	 * as A, A's push fails (offline, or A's session drops), the mutations
	 * queue in `A:<list>` and the ledger claims it. Now sign out of A
	 * keeping the changes — or just switch to a workspace of B's — and
	 * open the list. `resolveEffectiveAccount` hands back B, because a
	 * live session must always outrank a ledger claim: a claimant-wins
	 * rule would pull a genuinely different user on a shared device into
	 * A's store and push as them, which is strictly worse than the state
	 * it would fix. So we open `B:<list>` — a different store, an empty
	 * queue, pushes that succeed, and an indicator reading *All changes
	 * saved*.
	 *
	 * Every word of that is true about B and a lie about the list.
	 *
	 * ## Disclose, don't resolve around
	 *
	 * The resolution rule is right and stays. What was missing is that
	 * nobody *said* anything: A's work was invisible and unreachable for
	 * as long as B stayed current, while the app asserted the opposite.
	 * This banner is the disclosure and the escape hatch.
	 *
	 * ## The two offers
	 *
	 *  - **Switch to that account** — the real fix, and the only one that
	 *    saves the work: it reopens `A:<list>`, whose queue then drains on
	 *    its own. Note the current account is *derived from the active
	 *    workspace* here, so this is only offerable when the session can
	 *    see a workspace that account belongs to — being signed in is
	 *    necessary but not sufficient, hence `canSwitch` rather than a
	 *    membership test on `sessionAccounts`. When it isn't offerable
	 *    (the account was signed out of), the honest action is a sign-in,
	 *    and the copy says that instead of promising a switch we cannot
	 *    perform.
	 *
	 *  - **Discard them** — irreversible, never the default, and never
	 *    automatic.
	 *
	 * ## Why it may occasionally speak up about nothing
	 *
	 * The ledger over-claims by construction (claims are stamped before
	 * the mutation fires, and can only be retired by a client acting as
	 * the claimant), so a claim can outlive its work and no account but
	 * that one can notice. A rare false alarm is the cost of never missing
	 * a true one — the same trade the ledger already makes — and both
	 * offers are harmless against an empty store: switching opens it,
	 * finds nothing pending, and the tracker retires the claim on its own.
	 *
	 * Presentational only. The claim reasoning lives in `@djibb/client`
	 * (`strandedClaims`) and the reactive binding in
	 * `$lib/replicache/stranded.svelte.js`, for the same reason
	 * `diagnoseAuthBlock` doesn't live in `SessionExpiredBanner`: what we
	 * assert to a user about their unsaved work is worth testing directly.
	 */

	/**
	 * @typedef {Object} Props
	 * @property {ReturnType<typeof import('$lib/replicache/stranded.svelte.js').createStrandedState>} stranded
	 * @property {readonly import('@djibb/protocol/account').Account[]} sessionAccounts
	 * @property {(accountId: string) => boolean} canSwitch
	 * @property {(accountId: string) => void} onSwitch
	 * @property {string} signInHref
	 */

	/** @type {Props} */
	let { stranded, sessionAccounts, canSwitch, onSwitch, signInHref } = $props();

	/** @param {string} accountId */
	function nameFor(accountId) {
		const account = sessionAccounts.find((a) => a.id === accountId);
		if (!account) return null;
		return account.user_name || account.display_name || account.email || null;
	}
</script>

{#each stranded.claimants as accountId (accountId)}
	{@const name = nameFor(accountId)}
	<!-- assertive, like SessionExpiredBanner and for the same reason:
	     there is unsaved work here that the account in front of us cannot
	     save, and the indicator beside it would otherwise say everything
	     is fine. -->
	<aside
		class="stranded"
		role="alert"
		aria-live="assertive"
		data-testid="stranded-work-banner"
		data-account={accountId}
	>
		<p>
			<strong>Another account has unsaved changes on this list.</strong>
			Changes made {#if name}as {name}{:else}by an account you've since signed
				out of{/if} never reached the server. They're safe on this device, but only
			that account can save them — nothing you do here will.
		</p>
		<div class="actions">
			{#if canSwitch(accountId)}
				<button
					type="button"
					class="primary"
					onclick={() => onSwitch(accountId)}
				>
					Switch to that account
				</button>
			{:else}
				<a class="primary" href={signInHref}>Sign in to that account</a>
			{/if}
			<button
				type="button"
				class="danger"
				disabled={stranded.discarding === accountId}
				onclick={() => stranded.discard(accountId)}
			>
				{stranded.discarding === accountId ? 'Removing…' : 'Discard them'}
			</button>
		</div>
		{#if stranded.error}
			<p class="error">{stranded.error}</p>
		{/if}
	</aside>
{/each}

<style>
	.stranded {
		position: sticky;
		top: 0;
		z-index: 39;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
		justify-content: space-between;
		border: 1px solid #fde68a;
		background: #fffbeb;
		color: #78350f;
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		margin: 0.75rem 0;
	}
	.stranded p {
		margin: 0;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		flex: none;
	}
	.primary {
		background: #b45309;
		color: white;
		border: none;
		padding: 0.4rem 0.9rem;
		border-radius: 0.35rem;
		text-decoration: none;
		cursor: pointer;
	}
	.danger {
		background: none;
		border: 1px solid #b45309;
		color: #78350f;
		padding: 0.4rem 0.9rem;
		border-radius: 0.35rem;
		cursor: pointer;
	}
	.danger:disabled {
		opacity: 0.5;
	}
	.error {
		flex-basis: 100%;
		color: #7f1d1d;
		font-size: 0.85rem;
	}
</style>
