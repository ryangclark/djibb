// @ts-check
import { mutators } from '@djibb/protocol/list/mutators/client';
import {
	discardUnflushed,
	probeUnflushed,
	strandedClaims
} from '@djibb/client/unflushed';
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

	// Candidates, from the ledger — an INDEX of stores worth opening, not
	// an answer. Claims are stamped before their mutation fires and can
	// only be retired by a client acting as the claimant (who, on this
	// path, is by definition not here), so a claim can outlive its work
	// and nobody can tell. We do not interrupt a human on that.
	const claimants = $derived.by(() => {
		revision;
		return strandedClaims({
			ledger: unflushedLedger,
			entityId: entityId(),
			effectiveAccountId: actingAccountId()
		});
	});

	// The answer, from the stores themselves: `{ accountId, count }` for
	// the claimants that turn out to have durable work. Starts empty and
	// stays empty until a probe says otherwise — a banner that appears and
	// then retracts is worse than either outcome, because it teaches the
	// user that this banner lies.
	/** @type {{ accountId: string, count: number }[]} */
	let verified = $state([]);

	$effect(() => {
		const candidates = claimants;
		const entity = entityId();

		if (candidates.length === 0) {
			verified = [];
			return;
		}

		// Probes are async and the inputs can change under them (the user
		// switches account, another tab drains a queue). Only the newest run
		// may publish — a stale result landing last would resurrect a banner
		// for work that is already saved.
		let current = true;

		(async () => {
			/** @type {{ accountId: string, count: number }[]} */
			const found = [];
			for (const accountId of candidates) {
				try {
					const count = await probeUnflushed({
						accountId,
						entityId: entity,
						mutators
					});
					// Zero ⇒ SILENCE, never deletion. A zero probe cannot tell a
					// stale claim from a live tab whose mutation hasn't been
					// persisted yet (Replicache persists on its own schedule), and
					// retiring the claim on that ambiguity would orphan work about
					// to become durable — GH #43, rebuilt by hand. Say nothing;
					// leave the claim for its owner to retire.
					if (count > 0) found.push({ accountId, count });
				} catch (err) {
					// A failed read is UNKNOWN, not zero. Staying quiet is the same
					// outcome as zero here, but the distinction matters at the seam
					// (`probeUnflushed` deliberately throws rather than returning 0)
					// and it is worth a log: silence over real work is the failure
					// mode this whole area exists to prevent.
					console.error('Could not probe stranded work:', accountId, err);
				}
			}
			if (current) verified = found;
		})();

		return () => {
			current = false;
		};
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
		/**
		 * Claimants whose work we have actually SEEN on disk, with counts.
		 * Deliberately the only thing exposed: nothing renders off a raw
		 * ledger claim any more, which is what makes a stale claim harmless
		 * rather than a false alarm.
		 */
		get claimants() {
			return verified;
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
