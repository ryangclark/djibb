// @ts-check

/**
 * Sync-status tracker — the shared primitive behind the ambient
 * sync indicator (GH #7) and the session-expired banner (GH #6).
 *
 * The push auth-reconciliation policy in the DO (`handleMutation`)
 * made offline / expired-session edits *safe* — an unauthenticated
 * push throws, so the mutation stays queued and survives re-auth —
 * but it made them *invisible*: local optimistic state still looks
 * saved while nothing reaches the server. This tracker turns "safe
 * but stuck" into an observable state so the UI can say so.
 *
 * Two things are tracked:
 *
 *  - **pending count** — read from Replicache's own pending-mutation
 *    list, so it's the real queue depth, not a count we maintain.
 *  - **auth-blocked** — pushes persistently rejected with 401/403.
 *    Persistence matters: a single failure (a push racing a session
 *    refresh, say) must not flash the banner, so it takes
 *    `authFailureThreshold` *consecutive* auth rejections to trip.
 *    Any successful push clears the streak.
 *
 * The push HTTP status is the trigger rather than the WebSocket
 * `mutation_outcome` channel because the exact case we care about —
 * an expired session pushing to an owned entity — throws at the
 * envelope cross-account check, before any per-mutation `auth`
 * outcome is ever emitted. The pusher sees it; the outcome channel
 * never does.
 *
 * DOM-free and framework-free (ADR 0014): callers get a snapshot on
 * every change via `onChange` and adapt it to their own reactivity
 * (`syncStatus.svelte.js` in the webapp wraps it in `$state`).
 */

/**
 * @typedef {object} SyncStatus
 * @property {number} pending
 *   Mutations queued locally and not yet acknowledged by the server.
 * @property {boolean} syncing
 *   A push or pull is in flight right now.
 * @property {boolean} authBlocked
 *   Pushes are persistently failing on auth; the queue can't drain
 *   until the user signs in again. djibb has no refresh token
 *   (magic-link / OAuth + HttpOnly cookie), so recovery is
 *   necessarily an interactive sign-in.
 */

/**
 * Frozen because it is a shared module-level value that consumers seed
 * their reactive state with (`$state(INITIAL_STATUS)` in the webapp).
 * Svelte deep-proxies what it's given, so an accidental field write
 * through that proxy would mutate this object for every tracker created
 * afterwards in the same page. Nothing does that today; freezing means
 * nothing quietly can.
 *
 * @type {Readonly<SyncStatus>}
 */
export const INITIAL_STATUS = Object.freeze({
	pending: 0,
	syncing: false,
	authBlocked: false
});

/**
 * @param {object} input
 * @param {(status: SyncStatus) => void} input.onChange
 *   Called with a fresh snapshot whenever any field changes.
 * @param {number} [input.authFailureThreshold=2]
 *   Consecutive push 401/403s required before declaring the client
 *   auth-blocked. Two, not one, so a transient failure can't flash
 *   the banner; Replicache's push retry backoff means the second
 *   attempt lands within seconds.
 */
export function createSyncTracker({ onChange, authFailureThreshold = 2 }) {
	let pending = 0;
	let syncing = false;
	let authFailures = 0;
	let closed = false;

	/** @type {import('replicache').Replicache | null} */
	let client = null;
	/** @type {(() => void) | null} */
	let unwatch = null;

	// `experimentalPendingMutations()` is a promise, and we fire it
	// from several events that can overlap (a push completing while a
	// local mutation lands). Sequence the reads so a slow earlier one
	// can't overwrite a fresher count.
	let readSeq = 0;

	/** @returns {SyncStatus} */
	function snapshot() {
		return {
			pending,
			syncing,
			authBlocked: authFailures >= authFailureThreshold
		};
	}

	/** @type {SyncStatus} */
	let last = snapshot();

	function emit() {
		const next = snapshot();
		if (
			next.pending === last.pending &&
			next.syncing === last.syncing &&
			next.authBlocked === last.authBlocked
		) {
			return;
		}
		last = next;
		onChange(next);
	}

	async function refreshPending() {
		if (!client || closed) return;
		const seq = ++readSeq;
		const mutations = await client.experimentalPendingMutations();
		// A later read already landed (or we've been closed) — drop this one.
		if (seq !== readSeq || closed) return;
		pending = mutations.length;
		emit();
	}

	return {
		get status() {
			return snapshot();
		},

		/**
		 * Called by the pusher with the push response's HTTP status.
		 *
		 * Only two outcomes move the auth streak: an auth rejection
		 * extends it, a success clears it. Everything else — 5xx, a
		 * 4xx that isn't auth — is left alone deliberately: those are
		 * failures the user can't fix by signing in, and treating them
		 * as "not auth-blocked" would clear a real streak the moment
		 * the server hiccupped mid-outage. A network failure (offline)
		 * throws inside the pusher's `fetch` before it can report a
		 * status, so it never reaches here at all, which is the
		 * behaviour we want: being offline is not being signed out.
		 *
		 * @param {number} httpStatusCode
		 */
		notifyPush(httpStatusCode) {
			if (closed) return;
			if (httpStatusCode === 401 || httpStatusCode === 403) {
				authFailures += 1;
			} else if (httpStatusCode >= 200 && httpStatusCode < 300) {
				authFailures = 0;
			}
			emit();
			void refreshPending();
		},

		/**
		 * Binds the tracker to a Replicache client. Kept separate from
		 * construction because the client needs `notifyPush` at build
		 * time (it's wired into the pusher), so the tracker has to
		 * exist first.
		 *
		 * @param {import('replicache').Replicache} rc
		 */
		attach(rc) {
			client = rc;

			// Fires on push/pull start and end. The end of a sync is when
			// the pending count can have dropped, so re-read it there.
			rc.onSync = (isSyncing) => {
				if (closed) return;
				syncing = isSyncing;
				emit();
				if (!isSyncing) void refreshPending();
			};

			// Every local mutation writes to the store, so the diff stream
			// is a reliable "the queue may have grown" signal — it catches
			// mutations made while offline, which never produce a sync at
			// all.
			unwatch = rc.experimentalWatch(() => {
				void refreshPending();
			});

			void refreshPending();
		},

		/**
		 * Ask Replicache to retry the queued pushes now. Used after the
		 * user returns from signing in: the fresh cookie means the same
		 * pending mutations will now be accepted, and waiting out the
		 * retry backoff would leave the banner up for no reason.
		 */
		retry() {
			if (closed || !client) return;
			void client.push();
		},

		close() {
			closed = true;
			unwatch?.();
			unwatch = null;
			client = null;
		}
	};
}
