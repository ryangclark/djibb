// @ts-check

import { describe, expect, it, vi } from 'vitest';
import { createSyncTracker } from './syncStatus.js';

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
	const tracker = createSyncTracker({ onChange, authFailureThreshold });
	tracker.attach(/** @type {any} */ (client));
	return { client, onChange, tracker };
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
