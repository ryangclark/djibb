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
		onDrained
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
