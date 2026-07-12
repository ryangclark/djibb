import { createSyncTracker, INITIAL_STATUS } from '@djibb/client/syncStatus';

/**
 * Svelte shell over the framework-agnostic sync tracker — the same
 * split as `initList` over `createReplicacheClient` (ADR 0014): the
 * tracking logic is DOM-free and testable in `@djibb/client`, and
 * this file is only the `$state` binding.
 *
 * Feeds both sync surfaces from one signal: `SyncIndicator` (the
 * ambient "is my work safe?" readout, GH #7) and
 * `SessionExpiredBanner` (the loud interrupt when the queue can't
 * drain without a sign-in, GH #6).
 *
 * @param {object} [input]
 * @param {() => void} [input.onDrained] Fired when the queue is seen empty.
 * @returns {{
 *   status: import('@djibb/client/syncStatus').SyncStatus,
 *   notifyPush: (httpStatusCode: number) => void,
 *   attach: (client: import('replicache').Replicache) => void,
 *   retry: () => void,
 *   close: () => void
 * }}
 */
export function createSyncStatusState({ onDrained } = {}) {
	/** @type {import('@djibb/client/syncStatus').SyncStatus} */
	let status = $state(INITIAL_STATUS);

	const tracker = createSyncTracker({
		// Reassign rather than mutate: the snapshot is a plain frozen-ish
		// value object, and a fresh reference is what the consuming
		// components' `$derived` labels key off.
		onChange: (next) => {
			status = next;
		},
		onDrained
	});

	return {
		get status() {
			return status;
		},
		notifyPush: tracker.notifyPush,
		attach: tracker.attach,
		retry: tracker.retry,
		close: tracker.close
	};
}
