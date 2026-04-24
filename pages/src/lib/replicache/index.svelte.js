import { Replicache } from 'replicache';
import { dev } from '$app/environment';
import { mutators } from '$djibb/list/mutators/client';

/**
 * Initializes the Replicache Client stuff.
 * This is mostly specific for a List instance.
 * We'll have to figure out how we might generalize stuff later.
 *
 * @param {object} input List ID
 * @param {string | null} input.accountId Account ID
 * @param {string} input.listId List ID
 */
export function initList({ accountId, listId }) {
	/** @type {Object.<string, import('replicache').ReadonlyJSONValue>} */
	const listData = $state({});

	if (!listId) {
		throw new Error('Missing List Id!');
	}

	const replicacheClient = InitReplicacheClient({ accountId, listId });

	/**
	 * Callback function to handle updates to the Replicache store by
	 * updating the data in the `listData` state rune.
	 *
	 * This is defined here to have `listData` in scope.
	 *
	 * @type {import('replicache').ExperimentalWatchNoIndexCallback}
	 */
	function replicacheExperimentalWatchCallback(diffs) {
		for (const diff of diffs) {
			if (diff.op === 'add' || diff.op === 'change') {
				listData[diff.key] = diff.newValue;
			} else {
				console.warn(
					'replicacheExperimentalWatchCallback unhandled diff.op:',
					diff
				);
			}
		}
	}

	// Watch for changes.
	replicacheClient.experimentalWatch(replicacheExperimentalWatchCallback, {
		initialValuesInFirstDiff: true
	});

	replicacheClient
		.query((tx) => tx.isEmpty())
		.then((isEmpty) => {
			if (isEmpty) {
				replicacheClient.mutate.initList({
					accountId,
					listId,
					timestamp_client: new Date(),
					workspaceId: null // TODO: implement workspace
				});
			}
		});

	// Return the Svelte stuff we'll use to interact with
	// the Replicache client.
	return {
		client: replicacheClient,
		get list() {
			return listData;
		}
	};
}

/**
 * Initializes the Replicache Client stuff.
 *
 * @param {object} input List ID
 * @param {string | null} input.accountId Account ID
 * @param {string} input.listId List ID
 */
export function InitReplicacheClient({ accountId, listId }) {
	const licenseKey = import.meta.env.VITE_REPLICACHE_LICENSE_KEY;
	if (!licenseKey) {
		throw new Error('Missing VITE_REPLICACHE_LICENSE_KEY');
	}

	const protocol = `http${dev ? '' : 's'}:`;

	return new Replicache({
		licenseKey,
		// logLevel: import.meta.env.DEV ? 'debug' : 'error',
		mutators: mutators,
		// Template string to create something like `userId123:listId123`.
		// If no Account ID, it'll be `null:listId123`.
		name: `${accountId}:${listId}`,
		// Event-driven sync: poke via websocket triggers pulls; no polling.
		// pushDelay: null,
		// pullInterval: null,
		pullURL: `${protocol}//${import.meta.env.VITE_REPLICACHE_BASE_URL}/list/pull?l=${listId}`,
		pushURL: `${protocol}//${import.meta.env.VITE_REPLICACHE_BASE_URL}/list/push?l=${listId}`,
		// Bump when stored value shapes change; forces old clients to reset.
		schemaVersion: '1'
	});
}
