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
 * @typedef {'expired' | 'signed-out'} AuthBlockCause
 */

/**
 * Why the pushes are being refused.
 *
 * `authBlocked` says only that pushes are persistently 401/403'd. That
 * is a *symptom*, and there are two conditions behind it that a user
 * experiences completely differently:
 *
 *  - **`expired`** — there is no session. Nothing to act as, so "your
 *    session expired, sign in" is both true and actionable.
 *
 *  - **`signed-out`** — there IS a live session, but not as the account
 *    this client pushes as. Sessions are multi-account, and signing out
 *    of one leaves the others alive; a client built while that account
 *    was present keeps stamping it into every mutation envelope, and the
 *    DO's cross-account check throws outright (unlike a role denial,
 *    which is skip-and-acked per ADR 0020 so it can't wedge a push). The
 *    session is fine. Telling this user their session expired is a claim
 *    they can see is false, on a banner that cannot be dismissed.
 *
 * Lives here, in the client package, rather than in the Svelte component
 * that renders it: it is an authorization inference — it decides what we
 * assert to a user about the state of their session — and that is worth
 * testing directly, in one place, rather than trusting a `$derived` in a
 * component with no test harness.
 *
 * `expired` is the deliberate fallback for every ambiguous input (no
 * acting account, no visible session, an account list we can't match
 * against). It is the claim that is safe to be wrong about: it never
 * asserts a live session that isn't there, and its call to action —
 * sign in — is correct either way.
 *
 * @param {object} input
 * @param {string | null} input.actingAccountId
 *   The account the client PUSHES AS: stamped into every mutation
 *   envelope and fixed when the client is built. Deliberately not the
 *   session's current account — the session can change out from under a
 *   running client, and that gap is the entire reason this exists.
 * @param {readonly { id: string }[]} input.sessionAccounts
 *   Accounts on the live session. Empty means no session at all.
 * @returns {AuthBlockCause}
 */
export function diagnoseAuthBlock({ actingAccountId, sessionAccounts }) {
	if (sessionAccounts.length === 0) return 'expired';
	if (!actingAccountId) return 'expired';
	const onSession = sessionAccounts.some(a => a.id === actingAccountId);
	return onSession ? 'expired' : 'signed-out';
}

/**
 * @param {object} input
 * @param {(status: SyncStatus) => void} input.onChange
 *   Called with a fresh snapshot whenever any field changes.
 * @param {number} [input.authFailureThreshold=2]
 *   Consecutive push 401/403s required before declaring the client
 *   auth-blocked. Two, not one, so a transient failure can't flash
 *   the banner; Replicache's push retry backoff means the second
 *   attempt lands within seconds.
 * @param {() => void} [input.onDrained]
 *   Fired whenever the queue is observed empty. This is the
 *   self-healing half of the unflushed-work ledger (GH #43): claims are
 *   written optimistically before each mutation, so the only thing that
 *   retires them is watching the real queue reach zero. Called on every
 *   observed-empty read, not just on a transition, so a claim left over
 *   from a previous session (tab died between the stamp and the mutate)
 *   is cleaned up on the next load rather than lingering forever.
 * @param {() => number} [input.markVersion]
 *   The ledger's monotonic mark counter (`ledger.markVersion`). Sampled
 *   across the async pending-count read so a claim staked mid-read is
 *   never retired by a snapshot taken before it existed.
 * @param {() => number} [input.inFlight]
 *   The ledger's count of claimed-but-not-yet-persisted mutations
 *   (`ledger.inFlight`). A read that begins while one is in flight sees a
 *   queue that does not contain it yet, so that read cannot be used to
 *   retire anything either. Together these two make retirement safe;
 *   retiring a claim for a still-pending mutation orphans it, which is
 *   the one failure this design refuses to accept.
 */
export function createSyncTracker({
	onChange,
	authFailureThreshold = 2,
	onDrained,
	markVersion,
	inFlight
}) {
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

		// Sampled either side of the await — see the trustworthiness check
		// below, which is where these actually earn their keep.
		const marksBefore = markVersion?.();
		const inFlightBefore = inFlight?.() ?? 0;
		const mutations = await client.experimentalPendingMutations();

		// A later read already landed (or we've been closed) — drop this one.
		if (seq !== readSeq || closed) return;

		const count = mutations.length;

		// Is this read trustworthy? Three conditions, all load-bearing:
		//
		//   marks unchanged      nothing was claimed while we were reading, and
		//   nothing in flight    nothing was claimed just BEFORE we started
		//   (before and after)   reading and is still being written.
		//
		// The in-flight pair is the subtle one. A mutation is claimed
		// synchronously but persisted asynchronously, so a read that starts
		// in that gap sees a queue that does not yet contain it — and the
		// mark counter is no help, because the mark already happened before
		// the read began.
		//
		// These counters are ledger-wide, not per-entity, so a mutation on
		// list B makes list A's tracker treat its read as stale too. That
		// only ever means A holds its claim a beat longer than strictly
		// necessary — it over-claims, which is the safe direction — so it is
		// not worth per-entity bookkeeping to avoid.
		const quiet =
			markVersion?.() === marksBefore &&
			inFlightBefore === 0 &&
			(inFlight?.() ?? 0) === 0;

		// An untrustworthy zero is not just unusable for retiring a claim —
		// it is unusable, full stop. Publishing it would set the indicator to
		// "All changes saved" over work that is a tick away from existing:
		// the exact sentence #6/#7 exist to prevent the app from saying. It
		// self-corrects on the next watch tick, but a sub-second flash of
		// "saved" over unsaved work is still a lie. Drop the read entirely;
		// the write that made it stale will trigger a fresh one.
		//
		// Only a *zero* is suspect. A non-zero count can't be an
		// under-report caused by a not-yet-persisted write.
		if (count === 0 && !quiet) return;

		pending = count;
		emit();

		if (pending === 0) onDrained?.();
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
