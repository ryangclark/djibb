// @ts-check
import { discardUnflushed, strandedClaims } from '@djibb/client/unflushed';
import { unflushedLedger } from './ledger.js';

/**
 * Svelte shell over `strandedClaims` (GH #46) — the same split as
 * `createSyncStatusState` over the sync tracker (ADR 0014): the
 * reasoning is DOM-free and unit-tested in `@djibb/client`, and this
 * file is only the reactive binding plus the one action.
 *
 * ## What it knows that the sync tracker cannot
 *
 * The tracker watches the queue of the store we have *open*. On a
 * multi-account device that is not the same as "everything on this list
 * is saved": account A's unflushed mutations live in `A:<entity>`, and a
 * client acting as B never opens it. B's queue is honestly empty while
 * the list demonstrably has unsaved work on it. This is the fact that
 * fills that gap, and both surfaces need it — the banner to offer the
 * escape hatch, the indicator to stop saying "All changes saved" over
 * the top of it.
 *
 * Which is why it lives here rather than inside the banner: two
 * consumers of one fact must not each compute it, or they will disagree
 * about whether the app is lying.
 *
 * ## Reactivity
 *
 * `localStorage` is not reactive and nothing in this tab will change the
 * claim we're reporting — by definition it belongs to an account we are
 * *not* acting as. So we re-read on the events that can: our own discard,
 * another tab writing the ledger (`storage` fires only in other tabs,
 * which is exactly the case we could not otherwise see), and refocus,
 * for the sibling tab that drained the queue while we were away.
 *
 * @param {object} input
 * @param {() => string} input.entityId
 * @param {() => string | null} input.actingAccountId
 *   Getters, not values: the acting account is only known once the
 *   Replicache client is built, and it changes when the user takes the
 *   banner's own advice and switches accounts.
 */
export function createStrandedState({ entityId, actingAccountId }) {
	// Bumped whenever the ledger could have changed underneath us; the
	// only input `strandedClaims` has that Svelte can't see.
	let revision = $state(0);

	/** @type {string | null} */
	let discarding = $state(null);
	let error = $state('');

	const claimants = $derived.by(() => {
		revision;
		return strandedClaims({
			ledger: unflushedLedger,
			entityId: entityId(),
			effectiveAccountId: actingAccountId()
		});
	});

	$effect(() => {
		function refresh() {
			revision += 1;
		}
		window.addEventListener('storage', refresh);
		window.addEventListener('focus', refresh);
		return () => {
			window.removeEventListener('storage', refresh);
			window.removeEventListener('focus', refresh);
		};
	});

	return {
		get claimants() {
			return claimants;
		},
		get discarding() {
			return discarding;
		},
		get error() {
			return error;
		},

		/**
		 * Throw away one account's unflushed work **on this entity**.
		 *
		 * Scoped deliberately: this banner speaks for the list in front of
		 * the user, and the same account's stranded work on other lists is
		 * not theirs to destroy from here. (Account-wide discard exists, but
		 * it belongs to sign-out, where the user is making an account-wide
		 * decision.)
		 *
		 * Drops the IndexedDB store, not just the claim — deleting the claim
		 * alone would leave the mutations rotting in a store nothing will
		 * ever open again. Irreversible, hence never automatic.
		 *
		 * @param {string} accountId
		 */
		async discard(accountId) {
			if (discarding) return;
			discarding = accountId;
			error = '';
			try {
				await discardUnflushed({
					ledger: unflushedLedger,
					accountId,
					entityIds: [entityId()]
				});
			} catch (err) {
				// The user made an irreversible decision and we failed to carry
				// it out. Swallowing this would leave them believing the changes
				// are gone when they demonstrably aren't — and a `dropDatabase`
				// blocked by another open tab is the likely cause, which they can
				// actually do something about.
				error =
					'Could not remove those changes — another tab may still have ' +
					'this list open. Close it and try again.';
				console.error('Stranded-work discard failed:', err);
			} finally {
				discarding = null;
				// Re-read either way: a partial discard still retires the claims
				// it managed to drop, and the banner must reflect that honestly.
				revision += 1;
			}
		}
	};
}
