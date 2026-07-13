// @ts-check

import { describe, expect, it, vi } from 'vitest';
import { createSyncTracker, diagnoseAuthBlock } from './syncStatus.js';

/**
 * Minimal stand-in for the bits of the Replicache client the tracker
 * touches. `pending` is the queue depth it will report; tests set it
 * and then fire whichever event should cause a re-read.
 */
function fakeClient({ pending = 0 } = {}) {
	/** @type {(() => void)[]} */
	const watchers = [];
	const client = {
		pending,
		pushes: 0,
		/** @type {((syncing: boolean) => void) | null} */
		onSync: null,
		experimentalPendingMutations() {
			return Promise.resolve(Array.from({ length: client.pending }, () => ({})));
		},
		/** @param {() => void} cb */
		experimentalWatch(cb) {
			watchers.push(cb);
			return () => {
				watchers.splice(watchers.indexOf(cb), 1);
			};
		},
		push() {
			client.pushes += 1;
			return Promise.resolve();
		},
		// Test helpers.
		emitLocalChange() {
			for (const cb of watchers) cb();
		},
		watcherCount() {
			return watchers.length;
		}
	};
	return client;
}

function setup({ pending = 0, authFailureThreshold = 2 } = {}) {
	const client = fakeClient({ pending });
	const onChange = vi.fn();
	const onDrained = vi.fn();
	const tracker = createSyncTracker({
		onChange,
		authFailureThreshold,
		onDrained,
		markVersion: () => 0,
		inFlight: () => 0
	});
	tracker.attach(/** @type {any} */ (client));
	return { client, onChange, onDrained, tracker };
}

// Lets the tracker's in-flight `experimentalPendingMutations()` reads settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('pending count', () => {
	it('reflects the client queue after attach', async () => {
		const { tracker } = setup({ pending: 3 });
		await settle();
		expect(tracker.status.pending).toBe(3);
	});

	it('re-reads on a local change, so offline edits still count', async () => {
		// The offline case never produces a successful sync, so the diff
		// stream is the only signal that the queue grew.
		const { client, tracker } = setup({ pending: 0 });
		await settle();

		client.pending = 2;
		client.emitLocalChange();
		await settle();

		expect(tracker.status.pending).toBe(2);
	});

	it('drains to zero when a sync completes', async () => {
		const { client, tracker } = setup({ pending: 2 });
		await settle();

		client.pending = 0;
		client.onSync?.(true);
		expect(tracker.status.syncing).toBe(true);

		client.onSync?.(false);
		await settle();

		expect(tracker.status).toMatchObject({ pending: 0, syncing: false });
	});
});

describe('auth-blocked', () => {
	it('does not trip on a single transient auth failure', async () => {
		// A push racing a session refresh must not flash the banner.
		const { tracker } = setup();
		tracker.notifyPush(401);
		await settle();
		expect(tracker.status.authBlocked).toBe(false);
	});

	it('trips once auth failures are persistent', async () => {
		const { tracker } = setup();
		tracker.notifyPush(401);
		tracker.notifyPush(403);
		await settle();
		expect(tracker.status.authBlocked).toBe(true);
	});

	it('clears on the first successful push, so re-auth ends it', async () => {
		const { client, tracker } = setup({ pending: 2 });
		tracker.notifyPush(401);
		tracker.notifyPush(401);
		await settle();
		expect(tracker.status.authBlocked).toBe(true);

		// Re-authenticated: the queued mutations now push cleanly.
		client.pending = 0;
		tracker.notifyPush(200);
		await settle();

		expect(tracker.status).toMatchObject({ authBlocked: false, pending: 0 });
	});

	it('resets the streak on an interleaved success', async () => {
		const { tracker } = setup();
		tracker.notifyPush(401);
		tracker.notifyPush(200);
		tracker.notifyPush(401);
		await settle();
		// Two 401s total, but not consecutive — not a persistent failure.
		expect(tracker.status.authBlocked).toBe(false);
	});

	it('leaves the streak alone on a non-auth failure', async () => {
		// A 5xx mid-outage is not evidence the user got signed out, and
		// it is not evidence they didn't — it must move nothing.
		const { tracker } = setup();
		tracker.notifyPush(401);
		tracker.notifyPush(500);
		await settle();
		expect(tracker.status.authBlocked).toBe(false);

		tracker.notifyPush(401);
		await settle();
		expect(tracker.status.authBlocked).toBe(true);
	});
});

describe('drain signal (retires the unflushed-work claim, GH #43)', () => {
	it('fires when the queue empties', async () => {
		const { client, onDrained } = setup({ pending: 1 });
		await settle();
		expect(onDrained).not.toHaveBeenCalled();

		client.pending = 0;
		client.onSync?.(false);
		await settle();

		expect(onDrained).toHaveBeenCalled();
	});

	it('fires on a cold start with an empty queue', async () => {
		// This is what cleans up an over-claimed entry — one written just
		// before a tab died, so the mutation never actually landed. If the
		// signal only fired on a 1→0 *transition*, that claim would linger
		// forever and keep resolving the store to a stale account.
		const { onDrained } = setup({ pending: 0 });
		await settle();
		expect(onDrained).toHaveBeenCalled();
	});

	it('does not retire a claim staked while the read was in flight', async () => {
		// The stale-read orphan. `readSeq` only guards against a *later
		// read* superseding this one; it says nothing about a mark landing
		// mid-read, and marks don't go through refreshPending at all. So:
		//
		//   1. a read starts while the queue is empty
		//   2. the user mutates — claim stamped, mutation persists async
		//   3. the read resolves with the PRE-mutation snapshot (pending 0)
		//   4. without the mark-version check, we retire the claim here
		//   5. the mutation lands: durable, and unclaimed → orphaned
		//
		// No tab death required — just a push completing while someone
		// types. Under-claiming costs data, so the read must be treated as
		// stale for retirement purposes.
		const client = fakeClient({ pending: 0 });
		const onDrained = vi.fn();
		let marks = 0;

		// Model the real timing: the mark happens (synchronously, in
		// wrapMutators) while the pending-count read is outstanding, and the
		// queue only reflects it afterwards.
		client.experimentalPendingMutations = () =>
			Promise.resolve([]).then((empty) => {
				marks += 1; // a claim is staked mid-read
				client.pending = 1;
				return empty; // ...but this snapshot predates it
			});

		const tracker = createSyncTracker({
			onChange: () => {},
			onDrained,
			markVersion: () => marks
		});
		tracker.attach(/** @type {any} */ (client));
		await settle();

		expect(onDrained).not.toHaveBeenCalled();
	});

	it('does not retire a claim whose write has not landed yet', async () => {
		// The race that actually bit in the browser, and the one a mark
		// counter alone does NOT catch: the mark happened *before* the read
		// started, so the counter is unchanged across it — but Replicache
		// persists asynchronously, so the queue this read observes still
		// doesn't contain the mutation. Retiring here orphans it.
		//
		// (Found by the e2e: the ledger came back empty after an
		// expired-session edit, and the reload then opened the anonymous
		// store — exactly bug #43, reintroduced through the back door.)
		const client = fakeClient({ pending: 0 });
		const onDrained = vi.fn();

		const tracker = createSyncTracker({
			onChange: () => {},
			onDrained,
			markVersion: () => 1, // marked already; stable across the read
			inFlight: () => 1 // ...but the write hasn't landed
		});
		tracker.attach(/** @type {any} */ (client));
		await settle();

		expect(onDrained).not.toHaveBeenCalled();
	});

	it('never publishes an untrustworthy zero to the UI', async () => {
		// Declining to *retire* on a stale read is not enough: the same read
		// must not be allowed to set pending = 0 either, because that is
		// what the indicator renders as "All changes saved" — over work that
		// is a tick away from existing. It self-corrects on the next watch
		// tick, so it's a sub-second flash rather than a stranding, but a
		// flash of exactly the sentence #6/#7 exist to prevent is still a
		// lie, and step 3 of the e2e asserts against that very string.
		const client = fakeClient({ pending: 2 });
		/** @type {number[]} */
		const published = [];

		const tracker = createSyncTracker({
			onChange: (s) => published.push(s.pending),
			markVersion: () => 1,
			inFlight: () => 1 // a claimed write is still landing
		});
		tracker.attach(/** @type {any} */ (client));
		await settle();

		// The queue momentarily reads empty while that write is in flight.
		client.pending = 0;
		client.emitLocalChange();
		await settle();

		expect(published).not.toContain(0);
		expect(tracker.status.pending).toBe(2);
	});

	it('does not fire while work is still queued', async () => {
		const { client, onDrained } = setup({ pending: 0 });
		await settle();
		onDrained.mockClear();

		client.pending = 2;
		client.emitLocalChange();
		await settle();

		expect(onDrained).not.toHaveBeenCalled();
	});
});

describe('lifecycle', () => {
	it('only emits when the snapshot actually changes', async () => {
		const { onChange, tracker } = setup({ pending: 1 });
		await settle();
		const calls = onChange.mock.calls.length;

		tracker.notifyPush(200); // already clear, count unchanged
		await settle();

		expect(onChange.mock.calls.length).toBe(calls);
	});

	it('retry asks the client to push now', async () => {
		const { client, tracker } = setup();
		tracker.retry();
		expect(client.pushes).toBe(1);
	});

	it('goes quiet after close', async () => {
		const { client, onChange, tracker } = setup({ pending: 1 });
		await settle();
		tracker.close();
		const calls = onChange.mock.calls.length;

		client.pending = 9;
		tracker.notifyPush(401);
		tracker.notifyPush(401);
		tracker.retry();
		await settle();

		expect(onChange.mock.calls.length).toBe(calls);
		expect(client.pushes).toBe(0);
		expect(client.watcherCount()).toBe(0);
	});
});

describe('diagnoseAuthBlock — why the pushes are refused', () => {
	// The banner this feeds is non-dismissible, so a wrong diagnosis is a
	// claim the user can see is false and cannot make go away. These pin
	// which claim we make.

	it('no session at all is an expiry', () => {
		expect(
			diagnoseAuthBlock({ actingAccountId: 'a/1', sessionAccounts: [] })
		).toBe('expired');
	});

	it('a live session that lacks the acting account is a sign-out', () => {
		// THE bug: sessions are multi-account, so signing out of one leaves
		// the others alive while a client keeps pushing as the account that
		// left. The session did not expire, and saying so is a lie.
		expect(
			diagnoseAuthBlock({
				actingAccountId: 'a/1',
				sessionAccounts: [{ id: 'a/2' }]
			})
		).toBe('signed-out');
	});

	it('names the sign-out even when several accounts are signed in', () => {
		expect(
			diagnoseAuthBlock({
				actingAccountId: 'a/1',
				sessionAccounts: [{ id: 'a/2' }, { id: 'a/3' }]
			})
		).toBe('signed-out');
	});

	it('an anonymous client falls back to expiry', () => {
		// Nothing was signed out — there was never an account to sign out
		// of. "Sign in to save" is the right prompt regardless, and it is
		// the claim that is safe to be wrong about.
		expect(
			diagnoseAuthBlock({ actingAccountId: null, sessionAccounts: [] })
		).toBe('expired');
		expect(
			diagnoseAuthBlock({
				actingAccountId: null,
				sessionAccounts: [{ id: 'a/2' }]
			})
		).toBe('expired');
	});

	it('falls back to expiry when the acting account IS on the session', () => {
		// Shouldn't happen: an authorized account whose role can't run the
		// mutation is skip-and-ack'd (ADR 0020), not 403'd, so this state
		// has no known producer. Pinned anyway — an undefined answer here
		// is how a "shouldn't happen" becomes a crash or a blank banner.
		// `expired` at least prompts the one recovery that exists.
		expect(
			diagnoseAuthBlock({
				actingAccountId: 'a/1',
				sessionAccounts: [{ id: 'a/1' }, { id: 'a/2' }]
			})
		).toBe('expired');
	});
});
