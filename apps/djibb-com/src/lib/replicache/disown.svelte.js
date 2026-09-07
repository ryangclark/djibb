// @ts-check
import { tick } from 'svelte';
import { discardUnflushed, UnflushedDiscardError } from '@djibb/client/unflushed';
import { unflushedLedger } from './ledger.js';

/**
 * The "Discard and continue" escape hatch (GH #45), shared by the list
 * and template pages. The two pages had identical copies of this — the
 * state, the init-effect guard, and this ordering — diverging only in one
 * noun ('list' vs 'template'). Load-bearing ordering duplicated by hand is
 * ordering that drifts, so it lives here once.
 *
 * ## Why the order matters
 *
 * `deleteDatabase` (inside `discardUnflushed`) *blocks* — never rejects —
 * while any connection to the store is open, including our own live
 * client's. So the dance is:
 *
 *  1. flip `disowning`; the page's init effect reads it, stands down, and
 *     runs its cleanup — which closes the client;
 *  2. wait for that close to actually RESOLVE, not merely be called;
 *  3. drop the store, retiring the ledger claim with it;
 *  4. clear the flag; the effect re-runs and `resolveEffectiveAccount`
 *     resolves the account afresh — `null` for the anonymous visitor this
 *     exists for, or the current account if there is one.
 *
 * ## Why we await a handed-back promise, not just `tick()`
 *
 * `tick()` only guarantees the init effect's cleanup was *called*. The
 * cleanup calls `client.close()`, which returns a Promise that resolves
 * when IndexedDB has actually let go of the connection — and the effect
 * cleanup can't await it (cleanups are synchronous). If we dropped the
 * store on `tick()` alone, `deleteDatabase` could still be racing our own
 * closing handle and would only unwedge on its internal deadline, then
 * surface as a spurious "another tab may still have this open" (GH #45
 * review). So the cleanup hands its close promise back through
 * `handoffClose`, and `disown` awaits the real thing.
 *
 * @param {object} input
 * @param {'list' | 'template'} input.noun
 *   The entity word for the failure message — the only thing that differs
 *   between the two pages.
 */
export function createDisownController({ noun }) {
	let disowning = $state(false);
	let error = $state('');

	// The live client's close promise, handed over by the init effect's
	// cleanup while a disown is in flight. Null between disowns and until
	// the cleanup runs.
	/** @type {Promise<unknown> | null} */
	let closing = null;

	return {
		/**
		 * True while a disown is in progress. The page's init effect reads
		 * this to stand down (so its cleanup closes the client), and the
		 * banner reads it to disable and relabel the button.
		 */
		get disowning() {
			return disowning;
		},
		get error() {
			return error;
		},

		/**
		 * Called by the page's init-effect cleanup with the promise from
		 * `client.close()`, so `disown` can await the connection actually
		 * closing before it drops the store. Ignored unless a disown asked
		 * for the stand-down that triggered this cleanup.
		 *
		 * @param {Promise<unknown>} closed
		 */
		handoffClose(closed) {
			if (disowning) closing = closed;
		},

		/**
		 * Throw away the blocked work on this entity and let the client
		 * rebuild as whoever the session actually says we are.
		 *
		 * Scoped to this one entity, like the stranded banner's discard: the
		 * person saying "not me" is looking at one list, and the same
		 * account's work on other lists is not theirs to destroy from here.
		 *
		 * @param {object} input
		 * @param {string} input.entityId
		 * @param {string | null} input.accountId
		 *   The account the live client is acting as — the one whose store
		 *   and claim get dropped. From `actingAccountId`, not the session.
		 */
		async disown({ entityId, accountId }) {
			if (disowning || !accountId) return;
			error = '';
			closing = null;
			disowning = true;
			// Let the init effect observe `disowning`, stand down, and run
			// its cleanup — which closes the client and hands the close
			// promise back via `handoffClose`.
			await tick();
			// Wait for the connection to actually close before dropping the
			// store, or `deleteDatabase` blocks on our own handle (see above).
			if (closing) await closing;
			try {
				await discardUnflushed({
					ledger: unflushedLedger,
					accountId,
					entityIds: [entityId]
				});
			} catch (err) {
				// An explicit, irreversible request we failed to carry out: say
				// so. The claim survives a failed drop either way, so the next
				// load resolves to the same account and the same banner —
				// nothing is lost.
				//
				// But only `UnflushedDiscardError` means "the store is still
				// held open", which is the sole case where "close the other
				// tab" is true and actionable. `discardUnflushed` throws it
				// exclusively for a blocked drop; anything else (a bug, a
				// storage fault) is not tab contention, and telling the user to
				// hunt for a tab that isn't the problem is misleading. Say the
				// honest, generic thing there instead (review finding #2).
				if (err instanceof UnflushedDiscardError) {
					error =
						`Could not remove those changes — another tab may still ` +
						`have this ${noun} open. Close it and try again.`;
				} else {
					error =
						`Could not remove those changes — something went wrong. ` +
						`They're still here; please try again.`;
				}
				console.error('Disown failed:', err);
			} finally {
				closing = null;
				disowning = false;
			}
		}
	};
}
