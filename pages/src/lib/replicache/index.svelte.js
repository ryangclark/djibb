import { Replicache } from 'replicache';
import { dev } from '$app/environment';
import { mutators } from '../../../../workers/src/list/mutators';

/**
 * Initializes the Replicache Client stuff.
 * This is mostly specific for a List instance.
 * We'll have to figure out how we might generalize stuff later.
 *
 * TODO: determine whether userId should be optional. It seems like we
 * could create a fresh ID for a new user using `nanoid`? Will depend
 * how we do user management stuff, because we might have to "merge"
 * users if someone signs in after doing stuff beforehand...?
 *
 * @param {object} input List ID
 * @param {string} input.list_id List ID
 * @param {string} input.user_id User ID
 * For now, the User ID is required, though we might find a workaround for that later.
 */
export function initList({ list_id, user_id }) {
	/** @type {Object.<string, import('replicache').ReadonlyJSONValue>} */
	const listData = $state({});

	if (!list_id) {
		throw new Error('Missing List Id!');
	}

	// We may remove this as a requirement later. For now, it is.
	if (!user_id) {
		throw new Error('Missing User Id!');
	}

	const replicacheClient = $state(InitReplicacheClient({ list_id, user_id }));

	/**
	 * Callback function to handle updates to the Replicache store by
	 * updating the data in the `listData` state rune.
	 *
	 * This is defined here to have `listData` in scope.
	 *
	 * @type {import('replicache').ExperimentalWatchNoIndexCallback}
	 */
	function replicacheExperimentalWatchCallback(diffs) {
		// console.log('diffs', diffs);
		for (const diff of diffs) {
			if (diff.op === 'add' || diff.op === 'change') {
				// console.log(
				// 	'`repOnData` running! Updating key',
				// 	diff.key,
				// 	'to value:',
				// 	diff.newValue
				// );
				listData[diff.key] = diff.newValue;
			}
		}
	}

	// Watch for changes.
	replicacheClient.experimentalWatch(replicacheExperimentalWatchCallback, {
		initialValuesInFirstDiff: true
	});

	return {
		get client() {
			return replicacheClient;
		},
		get list() {
			return listData;
		}
	};
}

/**
 * Initializes the Replicache Client stuff.
 *
 * @param {object} input List ID
 * @param {string} input.list_id List ID
 * @param {string} input.user_id User ID
 */
export function InitReplicacheClient({ list_id, user_id }) {
	console.log(`\`init()\` for Replicache running for "${list_id}"!`);

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
		name: `${user_id}:${list_id}`,
		pullURL: `${protocol}//${import.meta.env.VITE_REPLICACHE_BASE_URL}/list/pull?l=${list_id}`,
		pushURL: `${protocol}//${import.meta.env.VITE_REPLICACHE_BASE_URL}/list/push?l=${list_id}`
	});
}
